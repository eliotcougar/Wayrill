//! Fixed pure application engine. This entry point runs only in a restricted
//! helper job; scripts, module names and filesystem access are not input data.
use rquickjs::{Context, Ctx, Function, Runtime, TypedArray};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use wayrill_protocol::{ApiError, Result};

const CODE: &str = include_str!(concat!(env!("OUT_DIR"), "/subscription-engine.js"));
const HOST: &str = r#"
globalThis.Intl = { Segmenter: class { segment(text) { return JSON.parse(__segments(text)); } } };
globalThis.crypto = { randomUUID: () => __uuid() };
globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
globalThis.atob = value => __atob(value);
globalThis.btoa = value => __btoa(value);
globalThis.TextEncoder = class { encode(value = '') { return __encode(value); } };
globalThis.TextDecoder = class { decode(value) { return __decode(value); } };
globalThis.URLSearchParams = class {
  constructor(value = '') { this.rows = typeof value === 'string' ? JSON.parse(__query(value.replace(/^\?/, ''))) : Array.from(value); }
  get(key) { return this.rows.find(row => row[0] === key)?.[1] ?? null; }
  getAll(key) { return this.rows.filter(row => row[0] === key).map(row => row[1]); }
  has(key) { return this.rows.some(row => row[0] === key); }
  keys() { return this.rows.map(row => row[0])[Symbol.iterator](); }
  entries() { return this.rows[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  append(key, value) { this.rows.push([key, value]); }
  set(key, value) { this.delete(key); this.append(key, value); }
  delete(key) { this.rows = this.rows.filter(row => row[0] !== key); }
  toString() { return this.rows.map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
};
globalThis.URL = class {
  constructor(value, base) { Object.assign(this, JSON.parse(__url(String(value), base === undefined ? '' : String(base)))); this.searchParams = new URLSearchParams(this.search); }
  toString() { return this.href; }
};
"#;

fn js_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        "SUBSCRIPTION_ENGINE",
        format!("Subscription processing failed: {error}"),
    )
}
fn encode<'js>(ctx: Ctx<'js>, text: String) -> rquickjs::Result<TypedArray<'js, u8>> {
    TypedArray::new(ctx, text.into_bytes())
}
fn decode(bytes: TypedArray<'_, u8>) -> rquickjs::Result<String> {
    // SAFETY: the array is rooted in this single-threaded context. No JS or
    // native callback executes between borrowing its storage and copying it.
    let copied = unsafe { bytes.as_bytes() }.unwrap_or_default().to_vec();
    String::from_utf8(copied)
        .map_err(|_| rquickjs::Error::new_from_js_message("bytes", "UTF-8", "Invalid UTF-8"))
}

fn url(text: String, base: String) -> rquickjs::Result<String> {
    let parsed = if base.is_empty() {
        url::Url::parse(&text)
    } else {
        url::Url::parse(&base).and_then(|base| base.join(&text))
    }
    .map_err(|_| rquickjs::Error::new_from_js_message("text", "URL", "Invalid URL"))?;
    Ok(json!({"href":parsed.as_str(),"protocol":format!("{}:", parsed.scheme()),
        "hostname":parsed.host_str().unwrap_or(""),"host":parsed[url::Position::BeforeHost..url::Position::AfterPort],
        "port":parsed.port().map(|p|p.to_string()).unwrap_or_default(),"pathname":parsed.path(),
        "search":parsed.query().map(|q|format!("?{q}")).unwrap_or_default(),
        "hash":parsed.fragment().map(|q|format!("#{q}")).unwrap_or_default(),
        "username":parsed.username(),"password":parsed.password().unwrap_or(""),
        "origin":parsed.origin().ascii_serialization()}).to_string())
}

pub fn execute(input: &Value) -> Result<Value> {
    let runtime = Runtime::new().map_err(js_error)?;
    runtime.set_memory_limit(640 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Instant::now() + Duration::from_secs(90);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(js_error)?;
    context.with(|ctx| -> Result<Value> {
        let globals = ctx.globals();
        globals.set("__segments", Function::new(ctx.clone(), |text: String| {
            use unicode_segmentation::UnicodeSegmentation;
            let mut index = 0;
            let rows: Vec<Value> = text.graphemes(true).map(|segment| {
                let row = json!({"index":index,"segment":segment});
                index += segment.encode_utf16().count(); row
            }).collect();
            serde_json::to_string(&rows).unwrap()
        }).map_err(js_error)?).map_err(js_error)?;
        globals.set("__encode", Function::new(ctx.clone(), encode).map_err(js_error)?).map_err(js_error)?;
        globals.set("__decode", Function::new(ctx.clone(), decode).map_err(js_error)?).map_err(js_error)?;
        globals.set("__url", Function::new(ctx.clone(), url).map_err(js_error)?).map_err(js_error)?;
        globals.set("__uuid", Function::new(ctx.clone(), || crate::tun::random_id().map_err(|_|rquickjs::Error::new_from_js_message("system", "identity", "Cannot generate a subscription identity"))).map_err(js_error)?).map_err(js_error)?;
        globals.set("__query", Function::new(ctx.clone(), |text: String| {
            serde_json::to_string(&url::form_urlencoded::parse(text.as_bytes()).collect::<Vec<_>>()).unwrap()
        }).map_err(js_error)?).map_err(js_error)?;
        globals.set("__atob", Function::new(ctx.clone(), |text: String| -> rquickjs::Result<String> {
            use base64::Engine;
            // Browser atob accepts omitted padding and ASCII whitespace. Key
            // validation uses it directly for unpadded Base64URL public keys.
            let bytes: Vec<_> = text.bytes().filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')).collect();
            let decoder = base64::engine::general_purpose::GeneralPurpose::new(
                &base64::alphabet::STANDARD,
                base64::engine::general_purpose::GeneralPurposeConfig::new()
                    .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                    .with_decode_allow_trailing_bits(true));
            decoder.decode(bytes)
                .map(|bytes| bytes.into_iter().map(char::from).collect())
                .map_err(|_| rquickjs::Error::new_from_js_message("text", "Base64", "Invalid Base64"))
        }).map_err(js_error)?).map_err(js_error)?;
        globals.set("__btoa", Function::new(ctx.clone(), |text: String| -> rquickjs::Result<String> {
            use base64::Engine;
            let bytes = text.chars().map(|c| u8::try_from(c as u32)).collect::<std::result::Result<Vec<_>,_>>()
                .map_err(|_| rquickjs::Error::new_from_js_message("text", "Base64", "Invalid binary string"))?;
            Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        }).map_err(js_error)?).map_err(js_error)?;
        ctx.eval::<(),_>(HOST).map_err(js_error)?;
        ctx.eval::<(),_>(CODE).map_err(|error| {
            let exception = ctx.catch();
            js_error(exception.as_exception().and_then(|e|e.message()).unwrap_or_else(||error.to_string()))
        })?;
        ctx.eval::<(),_>("globalThis.__run = text => { try { return JSON.stringify({ok:true,result:WayrillSubscriptions.subscriptionEngine(JSON.parse(text))}); } catch (e) { return JSON.stringify({ok:false,error:e.message}); } }").map_err(js_error)?;
        let run: Function = globals.get("__run").map_err(js_error)?;
        let output: String = run.call((input.to_string(),)).map_err(js_error)?;
        let value: Value = serde_json::from_str(&output).map_err(js_error)?;
        if value["ok"] == true { Ok(value["result"].clone()) }
        else { Err(ApiError::new("SUBSCRIPTION_CONFIG", value["error"].as_str().unwrap_or("Invalid subscription data."))) }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_base64_semantics_accept_unpadded_reality_keys() {
        use base64::Engine;
        let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 32]);
        let empty = execute(&json!({"operation":"validate","stash":""})).unwrap();
        let result = execute(&json!({"operation":"refresh","stash":empty["stash"],"groupId":"wayrill:default",
            "text":format!("vless://00000000-0000-0000-0000-000000000001@example.net:443?security=reality&sni=example.net&pbk={key}#Reality")})).unwrap();
        assert_eq!(result["catalog"][0]["entries"][0]["kind"], "vless-outbound");
        let validated = execute(&json!({"operation":"validate","stash":result["stash"]})).unwrap();
        assert_eq!(
            validated["catalog"][0]["entries"][0]["kind"],
            "vless-outbound"
        );
    }
    #[test]
    #[ignore = "Explicit synthetic subscription capacity measurement, no networking"]
    fn synthetic_subscription_capacity() {
        let count = std::env::var("WAYRILL_SUBSCRIPTION_CAPACITY")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(5000);
        assert!(count <= 50000);
        let empty = execute(&json!({"operation":"validate","stash":""})).unwrap();
        let text = (0..count)
            .map(|i| {
                format!(
                    "socks://user:password@192.0.2.1:{}#Synthetic-{i}",
                    10000 + i
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let start = Instant::now();
        let result=execute(&json!({"operation":"refresh","stash":empty["stash"],"groupId":"wayrill:default","text":text})).unwrap();
        let import_ms = start.elapsed().as_millis();
        assert_eq!(
            result["catalog"][0]["entries"].as_array().unwrap().len(),
            count
        );
        assert!(result["catalog"][0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["kind"] == "socks-outbound"));
        let start = Instant::now();
        let validated = execute(&json!({"operation":"validate","stash":result["stash"]})).unwrap();
        let validate_ms = start.elapsed().as_millis();
        assert_eq!(
            validated["catalog"][0]["entries"].as_array().unwrap().len(),
            count
        );
        let ids: Vec<_> = result["catalog"][0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .take(128)
            .map(|e| e["id"].clone())
            .collect();
        let start = Instant::now();
        let plan = execute(&json!({"operation":"plan","trusted":true,"stash":result["stash"],"groupId":"wayrill:default","entryIds":ids})).unwrap();
        let plan_ms = start.elapsed().as_millis();
        let observations: Vec<_> = ids.iter().map(|id|json!({"entryId":id,"health":{"profileId":plan["identities"][id.as_str().unwrap()],"checkedAt":1,"status":"alive","latencyMs":42}})).collect();
        let start = Instant::now();
        let health = execute(&json!({"operation":"health","trusted":true,"stash":result["stash"],"groupId":"wayrill:default","observations":observations})).unwrap();
        let health_ms = start.elapsed().as_millis();
        assert_eq!(
            health["catalog"][0]["entries"].as_array().unwrap().len(),
            count
        );
        println!(
            "{}",
            json!({"syntheticEntries":count,"importMs":import_ms,"validateMs":validate_ms,"plan128Ms":plan_ms,"health128Ms":health_ms,"stashBytes":result["stash"].as_str().unwrap().len(),"networking":false})
        );
    }
    #[test]
    fn subscription_credentials_survive_url_decoding_in_the_native_engine() {
        let result = execute(&json!({"operation":"refresh","stash":"","groupId":"wayrill:default",
            "text":"socks://qa%3Ap%40ss%3A%F0%9F%A6%8A@127.0.0.1:20922#Encoded\nsocks5://qa:@127.0.0.1:20923#Empty"})).unwrap();
        let stash: Value = serde_json::from_str(result["stash"].as_str().unwrap()).unwrap();
        let entries = stash["groups"][0]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        let ids: Vec<_> = entries.iter().map(|entry| entry["id"].clone()).collect();
        let plan = execute(&json!({"operation":"plan","stash":result["stash"],"groupId":"wayrill:default","entryIds":ids})).unwrap();
        let targets = plan["targets"].as_array().unwrap();
        assert_eq!(targets.len(), 2);
        for (index, password) in ["p@ss:🦊", ""].iter().enumerate() {
            assert_eq!(entries[index]["problem"], "");
            let target = &targets[index];
            let outbound = target["config"]["outbounds"]
                .as_array()
                .unwrap()
                .iter()
                .find(|outbound| outbound["tag"] == target["outboundTag"])
                .unwrap();
            assert_eq!(outbound["protocol"], "socks");
            assert_eq!(outbound["settings"]["user"], "qa");
            assert_eq!(outbound["settings"]["pass"], *password);
        }
    }
}
