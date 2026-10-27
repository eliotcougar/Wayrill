/** Shared small-response probes; manual HTTP(S) endpoints remain supported. */
export const testUrlSuggestions = [
  'https://www.google.com/generate_204',
  'https://www.youtube.com/generate_204',
  'https://www.gstatic.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
  'https://detectportal.firefox.com/success.txt',
  'https://www.apple.com/library/test/success.html',
  'http://www.msftconnecttest.com/connecttest.txt',
] as const;

/** JSON aliases understood by the service; IP-only responses need no country field. */
export const countryUrlSuggestions = [
  'https://api.ip.sb/geoip',
  'https://api-ipv4.ip.sb/geoip',
  'https://api-ipv6.ip.sb/geoip',
  'https://api.ipapi.is',
  'https://ipwho.is/',
  'https://ipinfo.io/json',
  'https://api.ipify.org?format=json',
] as const;

/** v2rayN download presets plus regional alternatives; all remain editable. */
export const speedUrlSuggestions = [
  'https://cachefly.cachefly.net/50mb.test',
  'https://cachefly.cachefly.net/100mb.test',
  'https://cachefly.cachefly.net/1mb.test',
  'https://cachefly.cachefly.net/10mb.test',
  'https://speed.cloudflare.com/__down?bytes=10000000',
  'https://speed.cloudflare.com/__down?bytes=50000000',
  'https://speed.cloudflare.com/__down?bytes=99999999',
  'https://speed.cloudflare.com/__down?bytes=250000000',
  'https://fsn1-speed.hetzner.com/100MB.bin',
  'https://hel1-speed.hetzner.com/100MB.bin',
  'https://ash-speed.hetzner.com/100MB.bin',
  'https://proof.ovh.net/files/100Mb.dat',
] as const;

/** STUN tests general UDP; DNS alternatives test the selected resolver's UDP port. */
export const udpUrlSuggestions = [
  'stun://stun.cloudflare.com:3478',
  'stun://global.stun.twilio.com:3478',
  'stun://frankfurt.stun.twilio.com:3478',
  'stun://singapore.stun.twilio.com:3478',
  'dns://1.1.1.1:53',
  'dns://8.8.8.8:53',
  'dns://9.9.9.9:53',
  'dns://9.9.9.9:9953',
  'dns://94.140.14.14:53',
  'dns://[2606:4700:4700::1111]:53',
  'dns://[2001:4860:4860::8888]:53',
] as const;
