use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Observation {
    Missing,
    Unavailable,
    Ready { config: Vec<Directive> },
}

#[derive(Debug, Serialize)]
pub(crate) struct Directive {
    name: String,
    args: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<Directive>,
}

pub(crate) const PROBE: &str = r#"
import os, shutil, subprocess, sys
exe = shutil.which("nginx")
if not exe and os.path.isfile("/usr/sbin/nginx"):
    exe = "/usr/sbin/nginx"
result = b"MISSING"
if exe:
    try:
        run = subprocess.run([exe, "-T"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
        result = run.stdout if not run.returncode and 0 < len(run.stdout) <= 768*1024 else b"UNAVAILABLE"
    except (OSError, subprocess.TimeoutExpired):
        result = b"UNAVAILABLE"
sys.stdout.buffer.write(b"WAYRILL_NGINX_BEGIN\n" + result + b"\nWAYRILL_NGINX_END\n")
"#;

pub(crate) fn observation(dump: &[u8]) -> Observation {
    let dump = dump.trim_ascii();
    if dump == b"MISSING" {
        return Observation::Missing;
    }
    let parsed = std::str::from_utf8(dump)
        .ok()
        .and_then(|dump| parse_dump(&dump.replace("\r\n", "\n")));
    match parsed {
        Some(config) => Observation::Ready { config },
        None => Observation::Unavailable,
    }
}

fn parse_dump(dump: &str) -> Option<Vec<Directive>> {
    let mut files = BTreeMap::new();
    let mut root = None;
    for piece in dump
        .strip_prefix("# configuration file ")?
        .split("\n# configuration file ")
    {
        let (file, source) = piece.split_once(":\n")?;
        if root.is_none() {
            root = Some(file);
        }
        files.insert(file, source);
    }
    // nginx normally starts its dump with this marker and a single main file.
    let root = root?;
    let (prefix, _) = root.rsplit_once('/')?;
    let mut budget = 100_000;
    expand(root, prefix, &files, 0, &mut budget, false)
}

fn expand(
    file: &str,
    prefix: &str,
    files: &BTreeMap<&str, &str>,
    depth: usize,
    budget: &mut usize,
    map_entries: bool,
) -> Option<Vec<Directive>> {
    if depth > 32 {
        return None;
    }
    let source = files.get(file)?;
    *budget = budget.checked_sub(source.len().div_ceil(8).max(1))?;
    let mut lexer = Lexer(source.chars().peekable());
    let nodes = block(&mut lexer, false, 0)?;
    retain_routes(nodes, prefix, files, depth, budget, map_entries)
}

fn retain_routes(
    nodes: Vec<Directive>,
    prefix: &str,
    files: &BTreeMap<&str, &str>,
    depth: usize,
    budget: &mut usize,
    map_entries: bool,
) -> Option<Vec<Directive>> {
    let mut result = Vec::new();
    for mut item in nodes {
        if map_entries && item.name != "include" {
            if item.args.len() != 1 || !safe_target(&item.args[0]) {
                item.args.clear();
            }
            item.children.clear();
            result.push(item);
            continue;
        }
        match item.name.as_str() {
            "include" => {
                let [pattern] = item.args.as_slice() else {
                    return None;
                };
                let path = if pattern.starts_with('/') {
                    pattern.clone()
                } else {
                    format!("{prefix}/{pattern}")
                };
                // glob(3) includes are sorted, and * must stay inside its path segment.
                let literal = !path.contains(['*', '?', '[']);
                let pattern = glob::Pattern::new(&path).ok()?;
                let options = glob::MatchOptions {
                    case_sensitive: true,
                    require_literal_separator: true,
                    require_literal_leading_dot: true,
                };
                let mut matches = files
                    .keys()
                    .filter(|file| pattern.matches_with(file, options))
                    .peekable();
                if literal && matches.peek().is_none() {
                    return None;
                }
                for file in matches {
                    result.extend(expand(file, prefix, files, depth + 1, budget, map_entries)?);
                }
                continue;
            }
            "http" | "stream" | "map" | "upstream" | "server" | "location" => {
                if item.name == "map" {
                    // Unrelated maps can contain secrets. Keep only maps that
                    // describe the handshake inputs modeled by Aquifer.
                    if !matches!(
                        item.args.first().map(String::as_str),
                        Some(
                            "$ssl_preread_server_name"
                                | "$ssl_preread_alpn_protocols"
                                | "$ssl_server_name"
                                | "$ssl_alpn_protocol"
                                | "$http_upgrade"
                        )
                    ) {
                        continue;
                    }
                }
                item.children = retain_routes(
                    item.children,
                    prefix,
                    files,
                    depth,
                    budget,
                    item.name == "map",
                )?;
            }
            "listen" | "server_name" | "ssl_preread" | "ssl" | "ssl_alpn" | "ssl_verify_client"
            | "http2" | "http3" | "proxy_protocol" | "proxy_ssl" | "proxy_http_version" => {}
            "proxy_pass" | "grpc_pass" | "pass" => {
                if !item.args.first().is_some_and(|value| safe_target(value)) {
                    item.args.clear();
                }
            }
            "if" => {
                if let Some(kind) = protocol_guard(&item) {
                    item.name = kind.into();
                }
                item.args.clear();
                item.children.clear();
            }
            "proxy_set_header" | "grpc_set_header" => {
                let [header, value] = item.args.as_slice() else {
                    continue;
                };
                if !["host", "upgrade", "connection", ":authority"]
                    .iter()
                    .any(|name| header.eq_ignore_ascii_case(name))
                    || !safe_target(value)
                {
                    // Header overrides also break nginx's inherited header set.
                    item.args.clear();
                }
            }
            "auth_basic" if item.args == ["off"] => {}
            "rewrite"
            | "return"
            | "try_files"
            | "auth_basic"
            | "auth_request"
            | "access_by_lua"
            | "access_by_lua_block"
            | "access_by_lua_file"
            | "rewrite_by_lua"
            | "rewrite_by_lua_block"
            | "rewrite_by_lua_file" => {
                item.args.clear();
                item.children.clear();
            }
            _ => continue,
        }
        result.push(item);
    }
    Some(result)
}

fn safe_target(value: &str) -> bool {
    !value.contains(['@', '?', '#']) && value.len() <= 2048
}

fn protocol_guard(item: &Directive) -> Option<&'static str> {
    let condition = item.args.join(" ");
    let [result] = item.children.as_slice() else {
        return None;
    };
    if result.name != "return"
        || result.args.len() != 1
        || !result.args[0]
            .parse::<u16>()
            .is_ok_and(|code| (400..600).contains(&code))
    {
        return None;
    }
    let test = condition.trim().strip_prefix('(')?.strip_suffix(')')?;
    let fields: Vec<_> = test.split_whitespace().collect();
    match fields.as_slice() {
        ["$http_upgrade", "!=", "websocket"] => Some("upgrade_required"),
        ["$request_method", "!=", "POST"] => Some("post_required"),
        ["$content_type", "!~", "application/grpc"] => Some("grpc_required"),
        _ => None,
    }
}

enum Token {
    Word(String),
    Block,
    End,
    Semi,
}

struct Lexer<'a>(std::iter::Peekable<std::str::Chars<'a>>);

impl Lexer<'_> {
    fn token(&mut self) -> Result<Option<Token>, ()> {
        let first = loop {
            match self.0.next() {
                None => return Ok(None),
                Some('#') => while self.0.next().is_some_and(|c| c != '\n') {},
                Some(value) if value.is_whitespace() => {}
                Some(value) => break value,
            }
        };
        if let Some(token) = match first {
            '{' => Some(Token::Block),
            '}' => Some(Token::End),
            ';' => Some(Token::Semi),
            _ => None,
        } {
            return Ok(Some(token));
        }
        let mut word = String::new();
        let mut current = Some(first);
        let mut quote = None;
        while let Some(value) = current {
            match value {
                '\\' => {
                    let next = self.0.next().ok_or(())?;
                    if !matches!(next, '\\' | '\'' | '"') {
                        word.push('\\');
                    }
                    word.push(next);
                }
                c if quote == Some(c) => quote = None,
                c @ ('\'' | '"') if quote.is_none() => quote = Some(c),
                '{' if quote.is_none() && word.ends_with('$') => {
                    word.push('{');
                    loop {
                        let c = self.0.next().ok_or(())?;
                        word.push(c);
                        if c == '}' {
                            break;
                        }
                    }
                }
                c => word.push(c),
            }
            if quote.is_none()
                && self.0.peek().is_some_and(|c| {
                    c.is_whitespace()
                        || matches!(c, ';' | '}')
                        || (*c == '{' && !word.ends_with('$'))
                })
            {
                break;
            }
            current = self.0.next();
        }
        if quote.is_some() {
            return Err(());
        }
        Ok(Some(Token::Word(word)))
    }
}

fn block(lexer: &mut Lexer<'_>, nested: bool, depth: usize) -> Option<Vec<Directive>> {
    if depth > 64 {
        return None;
    }
    let mut result = Vec::new();
    loop {
        let name = match lexer.token().ok()? {
            Some(Token::Word(name)) => name,
            Some(Token::End) if nested => return Some(result),
            None if !nested => return Some(result),
            _ => return None,
        };
        let mut args = Vec::new();
        let children = loop {
            match lexer.token().ok()?? {
                Token::Word(arg) => args.push(arg),
                Token::Block => break block(lexer, true, depth + 1)?,
                Token::Semi => break Vec::new(),
                Token::End => return None,
            }
        };
        result.push(Directive {
            name,
            args,
            children,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_dump_includes_in_context_and_omits_unrelated_secrets() {
        let config = parse_dump(
            r#"# configuration file /etc/nginx/nginx.conf:
stream { include stream.d/*.conf; }
http { include /etc/nginx/sites-enabled/*; }

# configuration file /etc/nginx/stream.d/a.conf:
map $ssl_preread_server_name $backend { example.test local; default local; }
upstream local { server 127.0.0.1:8443; }
server { listen 443; proxy_pass ${backend}; ssl_preread on; }

# configuration file /etc/nginx/sites-enabled/site:
server { listen 127.0.0.1:8443 ssl; server_name example.test;
  location ^~ "/a/#quoted" { proxy_pass http://unix:/run/xray.sock:; }
  location /public { proxy_set_header Authorization "secret"; proxy_pass http://127.0.0.1:99; }
  location /unsafe { proxy_pass http://name:secret@127.0.0.1; }
}
"#,
        )
        .unwrap();
        assert_eq!(config[0].children[2].children[1].args, ["${backend}"]);
        assert_eq!(config[1].children[0].children[2].args, ["^~", "/a/#quoted"]);
        let projected = serde_json::to_string(&config).unwrap();
        assert!(!projected.contains("secret"));
        assert!(projected.contains("http://unix:/run/xray.sock:"));
    }

    #[test]
    fn expands_included_alpn_maps_and_recognizes_protocol_guards() {
        let config = parse_dump(
            r#"# configuration file /etc/nginx/nginx.conf:
stream {
  map $ssl_preread_alpn_protocols $backend { include alpn.map; }
}
http { server {
  location /rpc {
    if ($request_method != "POST") { return 404; }
    if ($content_type !~ "application/grpc") { return 404; }
    if ($secret != "must-not-be-disclosed") { return 403; }
    grpc_pass unix:/run/server.sock;
  }
  location /ws {
    if ($http_upgrade != "websocket") { return 404; }
    proxy_pass http://127.0.0.1:8081;
  }
} }
# configuration file /etc/nginx/alpn.map:
~\bh2\b 127.0.0.1:8000;
default 127.0.0.1:8001;
"#,
        )
        .unwrap();
        let projected = serde_json::to_string(&config).unwrap();
        assert_eq!(config[0].children[0].children[0].name, r"~\bh2\b");
        for guard in ["post_required", "grpc_required", "upgrade_required"] {
            assert!(projected.contains(guard));
        }
        assert!(!projected.contains("must-not-be-disclosed"));
        assert_eq!(config[1].children[0].children[0].children[2].name, "if");
    }
}
