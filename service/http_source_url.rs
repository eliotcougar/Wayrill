use url::Url;

pub fn validate_http_source(text: &str, allow_http: bool) -> Result<Url, &'static str> {
    if text.len() > 8192 {
        return Err("Source URL is too long.");
    }
    let url = Url::parse(text).map_err(|_| "Enter a valid source URL.")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Source URLs require a host and cannot contain login credentials or a fragment.",
        );
    }
    if url.scheme() != "https" && !(allow_http && url.scheme() == "http") {
        return Err("Use HTTPS, or explicitly allow HTTP for this source.");
    }
    Ok(url)
}
