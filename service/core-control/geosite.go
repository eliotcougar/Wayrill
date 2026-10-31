package main

// Reverse lookup is an offline diagnostic. Stream records instead of retaining
// a decoded GeoSiteList, and use the same string matchers as the routing core.
import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/xtls/xray-core/common/geodata/strmatcher"
	"github.com/xtls/xray-core/common/platform"
	"google.golang.org/protobuf/encoding/protowire"
)

type geositeMatch struct {
	Code      string `json:"code"`
	Count     int    `json:"count"`
	MatchedBy string `json:"matchedBy"`
}

func bytesFields(data []byte, visit func(protowire.Number, protowire.Type, []byte) error) error {
	for len(data) > 0 {
		number, wire, n := protowire.ConsumeTag(data)
		if n < 0 {
			return protowire.ParseError(n)
		}
		data = data[n:]
		size := protowire.ConsumeFieldValue(number, wire, data)
		if size < 0 {
			return protowire.ParseError(size)
		}
		value := data[:size]
		if wire == protowire.BytesType {
			value, n = protowire.ConsumeBytes(value)
			if n < 0 {
				return protowire.ParseError(n)
			}
		}
		if err := visit(number, wire, value); err != nil {
			return err
		}
		data = data[size:]
	}
	return nil
}

func geositeMatches(ctx context.Context, data []byte, host string) ([]geositeMatch, error) {
	matches := []geositeMatch{}
	seen := map[string]bool{}
	regexes := map[string]strmatcher.Matcher{}
	records := 0
	err := bytesFields(data, func(number protowire.Number, wire protowire.Type, group []byte) error {
		if number != 1 {
			return nil
		}
		if wire != protowire.BytesType {
			return errors.New("invalid GeoSite group")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		row := geositeMatch{}
		err := bytesFields(group, func(number protowire.Number, wire protowire.Type, record []byte) error {
			switch number {
			case 1:
				if wire != protowire.BytesType {
					return errors.New("invalid GeoSite code")
				}
				row.Code = strings.ToLower(string(record))
			case 2:
				if wire != protowire.BytesType {
					return errors.New("invalid GeoSite record")
				}
				records++
				row.Count++
				if records > 4_000_000 {
					return errors.New("too many GeoSite records")
				}
				if records%256 == 0 {
					if err := ctx.Err(); err != nil {
						return err
					}
				}
				if row.MatchedBy != "" {
					return nil
				}
				kind := uint64(0)
				pattern := ""
				if err := bytesFields(record, func(n protowire.Number, w protowire.Type, v []byte) error {
					if n == 1 {
						if w != protowire.VarintType {
							return errors.New("invalid GeoSite type")
						}
						kind, _ = protowire.ConsumeVarint(v)
					}
					if n == 2 {
						if w != protowire.BytesType || !utf8.Valid(v) {
							return errors.New("invalid GeoSite pattern")
						}
						pattern = string(v)
					}
					return nil
				}); err != nil {
					return err
				}
				if kind > 3 {
					return nil // Xray ignores invalid entries within an otherwise usable group.
				}
				types := [4]strmatcher.Type{strmatcher.Substr, strmatcher.Regex, strmatcher.Domain, strmatcher.Full}
				if kind != 1 {
					pattern = strings.ToLower(pattern)
				}
				matcher := regexes[pattern]
				if kind != 1 || matcher == nil {
					var err error
					matcher, err = types[kind].New(pattern)
					if err != nil {
						return nil
					}
					if kind == 1 && len(regexes) < 1024 && len(pattern) <= 4096 {
						regexes[pattern] = matcher
					}
				}
				if matcher.Match(host) {
					row.MatchedBy = fmt.Sprintf("%.256s", matcher.String())
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		if row.Code == "" || strings.ContainsAny(row.Code, "@:\r\n\x00") || !utf8.ValidString(row.Code) || seen[row.Code] || len(seen) >= 65536 {
			return errors.New("invalid or duplicate GeoSite code")
		}
		seen[row.Code] = true
		if row.MatchedBy != "" {
			matches = append(matches, row)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(matches, func(a, b geositeMatch) int { return strings.Compare(a.Code, b.Code) })
	return matches, nil
}

func diagnosticGeosite(ctx context.Context, request diagnosticRequest) (any, error) {
	file := request.File
	if len(file) < 5 || len(file) > 200 || !strings.HasSuffix(file, ".dat") || filepath.Base(file) != file {
		return nil, errors.New("invalid resource filename")
	}
	for _, c := range strings.TrimSuffix(file, ".dat") {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return nil, errors.New("invalid resource filename")
		}
	}
	if request.Offset < 0 || request.Offset > 4_000_000 || request.Limit < 1 || request.Limit > 100 {
		return nil, errors.New("invalid page")
	}
	host := strings.TrimSuffix(strings.ToLower(request.Domain), ".")
	if host == "" || len(host) > 253 || strings.ContainsAny(host, ":/ \r\n\x00") {
		return nil, errors.New("invalid domain")
	}
	path := platform.GetAssetLocation(file)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 128<<20 {
		return nil, errors.New("invalid resource file size or type")
	}
	reader, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, (128<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 128<<20 {
		return nil, errors.New("resource file is too large")
	}
	rows, err := geositeMatches(ctx, data, host)
	if err != nil {
		return nil, err
	}
	total := len(rows)
	start := min(request.Offset, total)
	end := min(start+request.Limit, total)
	return map[string]any{"ready": true, "total": total, "offset": request.Offset, "rows": rows[start:end]}, nil
}
