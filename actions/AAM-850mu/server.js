async function(properties, context) {
    const maxLength = 50;
    const axios = require('axios');
    const key = context.keys.api_key;
    let list_length = 0;

    //check if list or single mode
    let urlArray = [];


    if (await properties.fileList === true) {
        list_length = await properties.file_urls.length();
        urlArray = await properties.file_urls.get(0, list_length);
    } else {
        const fileUrl = await properties.file_url;
        if (fileUrl && fileUrl.trim() !== "") {  // Check if single file is not empty
            urlArray.push(fileUrl);
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


    //Get the signed url (if applicable)
    function getRedirect(url) {
        return context.v3.async(async callback => {
            let signedUrl = url;
            // Check if URL starts with 'http', if not, prepend 'https:'
            if (!url.startsWith('http')) {
                signedUrl = 'https:' + url;
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
    const redirectPromises = urlArray.map(url => getRedirect(url));

    // Wait for all promises to resolve
    return Promise.all(redirectPromises)
        .then(redirects => {
            // Return an array of redirected URLs
            return {
                signed_urls: redirects,
            };
        })
        .catch(err => {
            // Handle errors
            console.error(err);
            return {
                returned_error: true,
                error_message: "An error occurred while fetching redirects."
            };
        });
}
