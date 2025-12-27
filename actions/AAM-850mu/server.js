async function(properties, context) {
    const maxLength = 50;
    const axios = require('axios');
    const key = context.keys.api_key;
    let list_length = 0;

    //check if list or single mode
    let urlArray = [];


    if (await properties.fileList === true) {
        list_length = await properties.file_urls.length();
        const rawUrls = await properties.file_urls.get(0, list_length);
        urlArray = rawUrls.map(url => url.trim()).filter(url => url !== "");
        list_length = urlArray.length;
    } else {
        const fileUrl = await properties.file_url;
        if (fileUrl && fileUrl.trim() !== "") {  // Check if single file is not empty
            urlArray.push(fileUrl.trim());
            list_length = 1;
        }
    }

    //check if list exceeds max or is empty
    if (list_length > maxLength || list_length < 1) {
        return {
            returned_error: true,
            error_message: list_length > maxLength
                ? `The list length (${list_length}) exceeds the maximum allowed length of ${maxLength}.`
                : "At least one url should be included."
        };
    }

    // Validate domains if enabled
    if (await properties.validate_domain === true) {
        // Get whitelisted domains from context and parse them
        const whitelistedDomainsStr = context.keys.whitelisted_domains || "";
        const customDomains = whitelistedDomainsStr
            .split(",")
            .map(domain => {
                // Trim whitespace
                domain = domain.trim().toLowerCase();
                
                // Remove protocol (http://, https://, //)
                domain = domain.replace(/^(https?:)?\/\//, "");
                
                // Remove trailing slash and path
                domain = domain.split("/")[0];
                
                return domain;
            })
            .filter(domain => domain !== "");
        
        // Always include bubble.io
        const allowedDomains = ["bubble.io", ...customDomains];

        // Function to extract domain from URL
        function extractDomain(url) {
            try {
                let normalizedUrl = url;
                if (!url.startsWith('http')) {
                    if (url.startsWith('//')) {
                        normalizedUrl = 'https:' + url;
                    } else {
                        normalizedUrl = 'https://' + url;
                    }
                }
                const urlObj = new URL(normalizedUrl);
                return urlObj.hostname.toLowerCase();
            } catch (e) {
                return null;
            }
        }

        // Function to check if a domain is whitelisted
        function isDomainWhitelisted(domain, allowedDomains) {
            if (!domain) return false;
            
            // Check for exact match or subdomain match for bubble.io
            return allowedDomains.some(allowedDomain => {
                if (domain === allowedDomain) return true;
                // Allow subdomains of whitelisted domains
                if (domain.endsWith('.' + allowedDomain)) return true;
                return false;
            });
        }

        // Validate all domains
        const invalidUrls = [];
        for (let i = 0; i < urlArray.length; i++) {
            const domain = extractDomain(urlArray[i]);
            if (!isDomainWhitelisted(domain, allowedDomains)) {
                invalidUrls.push({
                    index: i,
                    url: urlArray[i],
                    domain: domain
                });
            }
        }

        if (invalidUrls.length > 0) {
            const errorDetails = invalidUrls
                .map(item => `URL[${item.index}] "${item.url}" (domain: ${item.domain || 'invalid'})`)
                .join("; ");
            return {
                returned_error: true,
                error_message: `Domain validation failed for ${invalidUrls.length} URL(s). Allowed domains: ${allowedDomains.join(", ")}. Failed: ${errorDetails}`
            };
        }
    }


    //Get the signed url (if applicable)
    function getRedirect(url) {
        return context.v3.async(async callback => {
            let signedUrl = url;
            
            // Normalize and validate URL
            try {
                // Check if URL starts with 'http', if not, prepend 'https://'
                if (!url.startsWith('http')) {
                    // Handle protocol-relative URLs
                    if (url.startsWith('//')) {
                        signedUrl = 'https:' + url;
                    } else {
                        signedUrl = 'https://' + url;
                    }
                }
                
                // Validate URL format by creating URL object
                new URL(signedUrl);
            } catch (urlError) {
                callback(new Error(`Invalid URL format: ${url}`));
                return;
            }

            let response;
            try {
                // Try the authenticated request first
                response = await axios.head(signedUrl, {
                    maxRedirects: 0,
                    validateStatus: status => status === 302 || (status >= 200 && status < 300),
                    headers: { Authorization: `Bearer ${key}` }
                });
            } catch (authError) {
                try {
                    // If authenticated request fails, try the unauthenticated request
                    response = await axios.head(signedUrl, {
                        maxRedirects: 0,
                        validateStatus: status => status === 302 || (status >= 200 && status < 300)
                    });
                } catch (unauthError) {
                    callback(unauthError);
                    return;
                }
            }

            if (response.headers && response.headers.location) {
                callback(null, response.headers.location);
            } else {
                callback(null, signedUrl);
            }
        });
    }
    // Use Promise.all to make parallel requests for each URL
    const redirectPromises = urlArray.map((url, index) => 
        getRedirect(url).catch(err => ({
            url,
            index,
            error: err.message || String(err)
        }))
    );

    // Wait for all promises to resolve
    return Promise.all(redirectPromises)
        .then(redirects => {
            // Check for any errors in the results
            const errors = redirects.filter(result => result && result.error);
            
            if (errors.length > 0) {
                const errorDetails = errors
                    .map(e => `URL[${e.index}] "${e.url}": ${e.error}`)
                    .join("; ");
                return {
                    returned_error: true,
                    error_message: `Failed to fetch redirects for ${errors.length} URL(s): ${errorDetails}`
                };
            }
            
            // Return an array of redirected URLs
            return {
                signed_urls: redirects,
            };
        })
        .catch(err => {
            // Handle Promise.all errors
            console.error(err);
            return {
                returned_error: true,
                error_message: `An error occurred while fetching redirects: ${err.message || String(err)}`
            };
        });
}
