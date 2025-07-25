// ==UserScript==
// @name        AnnaUploader (Roblox Multi-File Uploader)
// @namespace   https://github.com/AnnaRoblox
// @version     6.7
// @description allows you to upload multiple T-Shirts/Decals easily with AnnaUploader
// @match       https://create.roblox.com/*
// @match       https://www.roblox.com/users/*/profile*
// @match       https://www.roblox.com/communities/*
// @match       https://www.roblox.com/home/*
// @run-at      document-idle
// @grant       GM_getValue
// @grant       GM_setValue
// @require     https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @require     https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js
// @license     MIT
// @downloadURL https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL   https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // Constants for Roblox API and asset types
    const ROBLOX_UPLOAD_URL  = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT  = 11;
    const ASSET_TYPE_DECAL   = 13;
    const FORCED_NAME        = "Uploaded Using AnnaUploader"; // Default name for assets

    // Storage keys and scan interval for asset logging
    const STORAGE_KEY = 'annaUploaderAssetLog';
    const SCAN_INTERVAL_MS = 10_000;

    // Script configuration variables, managed with Tampermonkey's GM_getValue/GM_setValue
    let USER_ID       = GM_getValue('userId', null);
    let IS_GROUP      = GM_getValue('isGroup', false);
    let useForcedName = GM_getValue('useForcedName', false); // Persist this setting
    let useMakeUnique = GM_getValue('useMakeUnique', false); // Persist this setting
    let uniqueCopies  = GM_getValue('uniqueCopies', 1);     // Persist this setting
    let useDownload   = GM_getValue('useDownload', false);  // Persist this setting
    let useForceCanvasUpload = GM_getValue('useForceCanvasUpload', false); // Persist this setting
    // NEW SETTING: Slip Mode Pixel Method - 'all_pixels' or '1-3_random'
    let slipModePixelMethod = GM_getValue('slipModePixelMethod', '1-3_random');

    // Mass upload mode variables
    let massMode    = false; // True if mass upload mode is active
    let massQueue   = [];    // Array to hold files/metadata for mass upload
    let batchTotal  = 0;     // Total items to process in current batch/queue
    let completed   = 0;     // Number of items completed in current batch/queue

    let csrfToken = null; // Roblox CSRF token for authenticated requests
    let statusEl, toggleBtn, startBtn, copiesInput, downloadBtn, forceUploadBtn; // UI elements
    let uiContainer; // Reference to the main UI container element
    let settingsModal; // Reference to the settings modal element

    /**
     * Utility function to extract the base name of a filename (without extension).
     * @param {string} filename The full filename.
     * @returns {string} The filename without its extension.
     */
    function baseName(filename) {
        return filename.replace(/\.[^/.]+$/, '');
    }

    /**
     * Loads the asset log from GM_getValue storage.
     * @returns {Object} The parsed asset log, or an empty object if parsing fails.
     */
    function loadLog() {
        const raw = GM_getValue(STORAGE_KEY, '{}');
        try { return JSON.parse(raw); }
        catch { return {}; }
    }

    /**
     * Saves the asset log to GM_setValue storage.
     * @param {Object} log The asset log object to save.
     */
    function saveLog(log) {
        GM_setValue(STORAGE_KEY, JSON.stringify(log));
    }

    /**
     * Logs an uploaded asset's details.
     * @param {string} id The asset ID.
     * @param {string|null} imageURL The URL of the asset's image.
     * @param {string} name The name of the asset.
     */
    function logAsset(id, imageURL, name) {
        const log = loadLog();
        log[id] = {
            date: new Date().toISOString(),
            image: imageURL || log[id]?.image || null, // Preserve existing image if new one is null
            name: name || log[id]?.name || '(unknown)' // Preserve existing name if new one is null
        };
        saveLog(log);
        console.log(`[AssetLogger] logged asset ${id} at ${log[id].date}, name: ${log[id].name}, image: ${log[id].image || "none"}`);
    }

    /**
     * Scans the current page for Roblox asset links and logs them.
     * Runs periodically.
     */
    function scanForAssets() {
        console.log('[AssetLogger] scanning for assets…');
        document.querySelectorAll('[href]').forEach(el => {
            // Match asset IDs from various Roblox URLs
            let m = el.href.match(/(?:https?:\/\/create\.roblox\.com)?\/store\/asset\/(\d+)/)
                 || el.href.match(/\/dashboard\/creations\/store\/(\d+)\/configure/);
            if (m) {
                const id = m[1];
                let image = null;
                const container = el.closest('*'); // Find the closest parent element to search for image/name
                const img = container?.querySelector('img');
                if (img?.src) image = img.src;
                let name = null;
                const nameEl = container?.querySelector('span.MuiTypography-root'); // Common element for asset names
                if (nameEl) name = nameEl.textContent.trim();
                logAsset(id, image, name);
            }
        });
    }
    // Start periodic scanning for new assets
    setInterval(scanForAssets, SCAN_INTERVAL_MS);

    /**
     * Fetches a new CSRF token from Roblox. This token is required for upload requests.
     * @returns {Promise<string>} A promise that resolves with the CSRF token.
     * @throws {Error} If the CSRF token cannot be fetched.
     */
    async function fetchCSRFToken() {
        const resp = await fetch(ROBLOX_UPLOAD_URL, {
            method: 'POST',
            credentials: 'include', // Important for sending cookies
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}) // Empty body to trigger a 403 and get the token
        });
        if (resp.status === 403) {
            const tok = resp.headers.get('x-csrf-token');
            if (tok) {
                csrfToken = tok;
                console.log('[CSRF] token fetched');
                return tok;
            }
        }
        throw new Error('Cannot fetch CSRF token');
    }

    /**
     * Updates the status display in the UI.
     * Shows progress for ongoing uploads or queued count in mass mode.
     */
    function updateStatus() {
        if (!statusEl) return;
        if (massMode) {
            statusEl.textContent = `${massQueue.length} queued`;
        } else if (batchTotal > 0) {
            statusEl.textContent = `${completed} of ${batchTotal} processed`;
        } else {
            statusEl.textContent = ''; // Clear status if nothing is happening
        }
    }

    /**
     * Uploads a single file to Roblox as a T-Shirt or Decal.
     * Includes retry logic for common errors like bad CSRF token or moderated names.
     * @param {File} file The file to upload.
     * @param {number} assetType The type of asset (ASSET_TYPE_TSHIRT or ASSET_TYPE_DECAL).
     * @param {number} [retries=0] Current retry count.
     * @param {boolean} [forceName=false] Whether to force the default name for the asset.
     * @returns {Promise<void>} A promise that resolves when the upload is attempted.
     */
    async function uploadFile(file, assetType, retries = 0, forceName = false) {
        if (!csrfToken) {
            try {
                await fetchCSRFToken();
            } catch (e) {
                console.error("[Upload] Failed to fetch initial CSRF token:", e);
                completed++; // Count this as a failed attempt to proceed with batch
                updateStatus();
                return;
            }
        }
        const displayName = forceName ? FORCED_NAME : baseName(file.name);
        const creator = IS_GROUP
            ? { groupId: USER_ID }
            : { userId: USER_ID };

        const fd = new FormData();
        fd.append('fileContent', file, file.name); // The actual image file
        fd.append('request', JSON.stringify({ // JSON payload for the asset details
            displayName,
            description: FORCED_NAME, // Description is always the forced name
            assetType: assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal",
            creationContext: { creator, expectedPrice: 0 } // Price is always 0
        }));

        try {
            const resp = await fetch(ROBLOX_UPLOAD_URL, {
                method: 'POST',
                credentials: 'include',
                headers: { 'x-csrf-token': csrfToken }, // Add CSRF token to headers
                body: fd
            });
            const txt = await resp.text();
            let json; try { json = JSON.parse(txt); } catch (e) {
                console.error('[Upload] Failed to parse response JSON:', e, txt);
            }

            // NEW ERROR CHECK: If response indicates account is banned
            if (json?.message && typeof json.message === 'string' && json.message.toLowerCase().includes('banned')) {
                displayMessage('Upload failed: Your account appears to be banned. Cannot complete upload.', 'error');
                console.error(`[Upload] Account banned for "${file.name}":`, txt);
                completed++;
                updateStatus();
                return; // Stop processing this file
            }

            // Handle successful upload
            if (resp.ok && json?.assetId) {
                logAsset(json.assetId, null, displayName);
                completed++; // Increment on success
                updateStatus(); // Update status immediately
                return; // Exit after successful upload
            }

            // Retry logic for common errors (no increment here, the recursive call will eventually increment)
            if (json?.message === 'Asset name length is invalid.' && !forceName && retries < 5) {
                console.warn(`[Upload] "${file.name}" name too long, retrying with default name. Retry ${retries + 1}.`);
                return uploadFile(file, assetType, retries + 1, true); // Retry with forced name
            }
            if (resp.status === 400 && json?.message?.includes('moderated') && retries < 5) {
                // If moderated, try again with default name (often resolves this)
                console.warn(`[Upload] "${file.name}" content moderated, retrying with default name. Retry ${retries + 1}.`);
                return uploadFile(file, assetType, retries + 1, true);
            }
            if (resp.status === 403 && retries < 5) {
                // CSRF token invalid or expired, fetch new and retry
                console.warn(`[Upload] "${file.name}" 403 Forbidden, fetching new CSRF and retrying. Retry ${retries + 1}.`);
                csrfToken = null; // Clear token to force refetch
                await fetchCSRFToken(); // Ensure a new token is fetched before retrying
                return uploadFile(file, assetType, retries + 1, forceName);
            }

            // If we reach here, it's a final failure after retries or an unhandled HTTP error
            console.error(`[Upload] failed "${file.name}" [${resp.status}]`, txt);
            completed++; // Increment even on final failure
            updateStatus(); // Update status for failed upload
        } catch (e) {
            console.error(`[Upload] error during fetch for "${file.name}":`, e);
            completed++; // Increment on network/unhandled JS error
            updateStatus(); // Update status for error
        }
    }

    /**
     * Converts a WebP image File to a PNG File.
     * @param {File} webpFile The WebP file to convert.
     * @returns {Promise<File>} A promise that resolves with the converted PNG File object.
     */
    function convertWebPToPng(webpFile) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                canvas.toBlob(blob => {
                    if (blob) {
                        const newFileName = webpFile.name.replace(/\.webp$/, '.png');
                        resolve(new File([blob], newFileName, { type: 'image/png' }));
                    } else {
                        reject(new Error('Failed to convert WebP to PNG blob.'));
                    }
                }, 'image/png');
            };
            img.onerror = (e) => {
                reject(new Error(`Failed to load image for conversion: ${e.message}`));
            };
            img.src = URL.createObjectURL(webpFile);
        });
    }

    /**
     * Processes an image file through a canvas, re-encoding it to the target type (defaulting to PNG).
     * This can fix issues with malformed image data or incorrect MIME types.
     * @param {File} file The original image file.
     * @param {string} targetType The desired output MIME type (e.g., 'image/png').
     * @returns {Promise<File>} A promise that resolves with the new, re-encoded File object.
     */
    function processImageThroughCanvas(file, targetType = 'image/png') {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                canvas.toBlob(blob => {
                    if (blob) {
                        // Preserve original base name, but update extension and type
                        const newFileName = baseName(file.name) + (targetType === 'image/png' ? '.png' : '.jpeg'); // Simple extension logic
                        resolve(new File([blob], newFileName, { type: targetType }));
                    } else {
                        reject(new Error('Failed to process image through canvas.'));
                    }
                }, targetType);
            };
            img.onerror = (e) => {
                reject(new Error(`Failed to load image for canvas processing: ${e.message}`));
            };
            img.src = URL.createObjectURL(file);
        });
    }

    /**
     * "Slip Mode": subtly randomizes pixels to create unique images.
     * The method of randomization (all pixels or 1-3 random pixels) depends on `slipModePixelMethod`.
     * @param {File} file The original image file.
     * @param {string} origBase The base name of the original file.
     * @param {number} copyIndex The index of the copy (for naming).
     * @returns {Promise<File>} A promise that resolves with the new unique image File object.
     */
    function makeUniqueFile(file, origBase, copyIndex) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data; // Pixel data: [R, G, B, A, R, G, B, A, ...]

                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] !== 0) { // Check if alpha channel is not zero (i.e., not transparent)
                        let delta;
                        if (slipModePixelMethod === 'all_pixels') {
                            // Adjust all color channels by a random delta of ±1
                            delta = (Math.random() < 0.5 ? -1 : 1);
                            data[i]     = Math.min(255, Math.max(0, data[i]     + delta)); // Red
                            data[i+1]   = Math.min(255, Math.max(0, data[i+1] + delta)); // Green
                            data[i+2]   = Math.min(255, Math.max(0, data[i+2] + delta)); // Blue
                        } else { // '1-3_random'
                            // Adjust all color channels by a random delta of ±1 to ±3
                            delta = (Math.random() < 0.5 ? -1 : 1) * (Math.floor(Math.random() * 3) + 1);
                            data[i]     = Math.min(255, Math.max(0, data[i]     + delta)); // Red
                            data[i+1]   = Math.min(255, Math.max(0, data[i+1] + delta)); // Green
                            data[i+2]   = Math.min(255, Math.max(0, data[i+2] + delta)); // Blue
                        }
                    }
                }
                ctx.putImageData(imageData, 0, 0); // Put modified data back to canvas

                canvas.toBlob(blob => {
                    const ext = 'png'; // Always output PNG after processing, especially if converted from WebP
                    const newName = `${origBase}_${copyIndex}.${ext}`; // Create new name with index
                    resolve(new File([blob], newName, { type: 'image/png' })); // Resolve with new File object as PNG
                }, 'image/png'); // Always convert to PNG
            };
            img.src = URL.createObjectURL(file); // Load image from file blob URL
        });
    }

    /**
     * Handles file selection from input or paste events.
     * Depending on `massMode`, it either queues files or initiates immediate uploads.
     * @param {FileList|File[]} files The list of files selected.
     * @param {number|null} assetType The asset type (TSHIRT, DECAL, or null for 'both').
     * @param {boolean} [both=false] If true, upload as both T-Shirt and Decal.
     */
    async function handleFileSelect(files, assetType, both = false) {
        if (!files?.length) return;

        const downloadsMap = {};
        const copies = useMakeUnique ? uniqueCopies : 1;

        if (massMode) {
            // In mass mode, add files to the queue after processing
            displayMessage('Processing files to add to queue...', 'info');
            const processingTasks = [];
            for (const original of files) {
                let fileToProcess = original;

                // 1. WebP Conversion (always happens first if needed)
                if (original.type === 'image/webp') {
                    displayMessage(`Converting ${original.name} from WebP to PNG...`, 'info');
                    try {
                        fileToProcess = await convertWebPToPng(original);
                        displayMessage(`${original.name} converted to PNG.`, 'success');
                    } catch (error) {
                        displayMessage(`Failed to convert ${original.name}: ${error.message}`, 'error');
                        console.error(`[Conversion] Failed to convert ${original.name}:`, error);
                        continue; // Skip this file if conversion fails
                    }
                }

                // 2. Force Canvas Upload (if enabled AND not already handled by makeUniqueFile)
                // If useMakeUnique is true, makeUniqueFile already processes through canvas, so no need to double process.
                let fileAfterCanvasProcessing = fileToProcess;
                if (useForceCanvasUpload && !useMakeUnique) {
                    displayMessage(`Processing ${fileToProcess.name} through canvas...`, 'info');
                    try {
                        fileAfterCanvasProcessing = await processImageThroughCanvas(fileToProcess);
                        displayMessage(`${fileToProcess.name} processed through canvas.`, 'success');
                    } catch (error) {
                        displayMessage(`Failed to process ${fileToProcess.name} through canvas: ${error.message}`, 'error');
                        console.error(`[Canvas Process] Failed to process ${fileToProcess.name}:`, error);
                        continue; // Skip this file if canvas processing fails
                    }
                }

                const origBase = baseName(fileAfterCanvasProcessing.name); // Use the name from the potentially canvas-processed file
                for (let i = 1; i <= copies; i++) {
                    processingTasks.push(
                        (async () => {
                            const fileForQueue = useMakeUnique
                                ? await makeUniqueFile(fileAfterCanvasProcessing, origBase, i)
                                : fileAfterCanvasProcessing; // Use the file after potential canvas processing

                            if (both) {
                                massQueue.push({ f: fileForQueue, type: ASSET_TYPE_TSHIRT, forceName: useForcedName });
                                massQueue.push({ f: fileForQueue, type: ASSET_TYPE_DECAL, forceName: useForcedName });
                            } else {
                                massQueue.push({ f: fileForQueue, type: assetType, forceName: useForcedName });
                            }
                        })()
                    );
                }
            }
            await Promise.all(processingTasks); // Wait for all files to be processed and queued
            displayMessage(`${processingTasks.length} files added to queue!`, 'success');
            updateStatus(); // Update status to show queued items
        } else {
            // Not in mass mode, proceed with immediate upload
            const totalFilesToUpload = files.length * (both ? 2 : 1) * copies;
            batchTotal = totalFilesToUpload; // Set total for immediate batch
            completed = 0;
            updateStatus();
            displayMessage(`Starting upload of ${batchTotal} files...`, 'info');

            const uploadPromises = []; // Array to hold upload promises

            for (const original of files) {
                let fileToProcess = original;

                // 1. WebP Conversion (always happens first if needed)
                if (original.type === 'image/webp') {
                    displayMessage(`Converting ${original.name} from WebP to PNG...`, 'info');
                    try {
                        fileToProcess = await convertWebPToPng(original);
                        displayMessage(`${original.name} converted to PNG.`, 'success');
                    } catch (error) {
                        displayMessage(`Failed to convert ${original.name}: ${error.message}`, 'error');
                        console.error(`[Conversion] Failed to convert ${original.name}:`, error);
                        continue; // Skip this file if conversion fails
                    }
                }

                // 2. Force Canvas Upload (if enabled AND not already handled by makeUniqueFile)
                let fileAfterCanvasProcessing = fileToProcess;
                if (useForceCanvasUpload && !useMakeUnique) {
                    displayMessage(`Processing ${fileToProcess.name} through canvas...`, 'info');
                    try {
                        fileAfterCanvasProcessing = await processImageThroughCanvas(fileToProcess);
                        displayMessage(`${fileToProcess.name} processed through canvas.`, 'success');
                    } catch (error) {
                        displayMessage(`Failed to process ${fileToProcess.name} through canvas: ${error.message}`, 'error');
                        console.error(`[Canvas Process] Failed to process ${fileToProcess.name}:`, error);
                        continue; // Skip this file if canvas processing fails
                    }
                }

                const origBase = baseName(fileAfterCanvasProcessing.name); // Use the name from the potentially canvas-processed file
                downloadsMap[origBase] = []; // Initialize for potential downloads

                for (let i = 1; i <= copies; i++) {
                    const fileToUpload = useMakeUnique
                        ? await makeUniqueFile(fileAfterCanvasProcessing, origBase, i)
                        : fileAfterCanvasProcessing; // Get the processed file

                    if (useMakeUnique && useDownload) downloadsMap[origBase].push(fileToUpload);
                    if (both) {
                        uploadPromises.push(uploadFile(fileToUpload, ASSET_TYPE_TSHIRT, 0, useForcedName));
                        uploadPromises.push(uploadFile(fileToUpload, ASSET_TYPE_DECAL, 0, useForcedName));
                    } else {
                        uploadPromises.push(uploadFile(fileToUpload, assetType, 0, useForcedName));
                    }
                }
            }

            // Wait for all immediate uploads to complete
            Promise.all(uploadPromises).then(() => {
                console.log('[Uploader] batch done');
                scanForAssets(); // Rescan for newly uploaded assets
                displayMessage('Immediate upload batch complete!', 'success');
                // Handle downloading of unique images if enabled
                if (useMakeUnique && useDownload) {
                    for (const [origBase, fileList] of Object.entries(downloadsMap)) {
                        if (!fileList.length) continue;
                        const zip = new JSZip();
                        fileList.forEach(f => zip.file(f.name, f));
                        zip.generateAsync({ type: 'blob' }).then(blob => {
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${origBase}.zip`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                        });
                    }
                }
            }).catch(error => {
                console.error("Immediate upload batch encountered an error:", error);
                displayMessage('Immediate upload batch finished with errors. Check console.', 'error');
            });
        }
    }

    /**
     * Starts the mass upload process for all files currently in the queue.
     */
    function startMassUpload() {
        if (!massQueue.length) {
            displayMessage('Nothing queued for mass upload!', 'info');
            return;
        }

        batchTotal = massQueue.length; // Set total for this mass upload batch
        completed = 0; // Reset completed counter for the new batch
        updateStatus();
        displayMessage(`Starting mass upload of ${batchTotal} files...`, 'info');

        // Create an array of promises for each upload task
        const tasks = massQueue.map(item => uploadFile(item.f, item.type, 0, item.forceName));
        massQueue = []; // Clear the queue once uploads begin

        // Wait for all uploads in the mass batch to complete
        Promise.all(tasks).then(() => {
            displayMessage('Mass upload complete!', 'success');
            // Reset mass mode and UI elements after completion
            massMode = false;
            toggleBtn.textContent = 'Enable Mass Upload';
            startBtn.style.display = 'none';
            scanForAssets(); // Rescan for all newly uploaded assets
            batchTotal = completed = 0; // Reset progress counters for next operation
            updateStatus(); // Final status update
        }).catch(error => {
            console.error("Mass upload encountered an error:", error);
            displayMessage('Mass upload finished with errors. Check console.', 'error');
            massMode = false;
            toggleBtn.textContent = 'Enable Mass Upload';
            startBtn.style.display = 'none';
            batchTotal = completed = 0;
            updateStatus();
        });
    }

    /**
     * Displays a custom modal message instead of `alert()`.
     * @param {string} message The message to display.
     * @param {'info'|'success'|'error'} [type='info'] The type of message for styling.
     */
    function displayMessage(message, type = 'info') {
        const modal = document.createElement('div');
        Object.assign(modal.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            padding: '20px',
            background: '#333',
            color: '#fff',
            borderRadius: '8px',
            boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
            zIndex: '10001',
            fontFamily: 'Inter, Arial, sans-serif',
            textAlign: 'center',
            minWidth: '250px',
            transition: 'opacity 0.3s ease-in-out',
            opacity: '0' // Start hidden for transition
        });

        if (type === 'success') {
            modal.style.background = '#4CAF50'; // Green
        } else if (type === 'error') {
            modal.style.background = '#f44336'; // Red
        }

        modal.textContent = message;

        document.body.appendChild(modal);

        // Fade in
        setTimeout(() => modal.style.opacity = '1', 10);

        // Fade out and remove after a delay
        setTimeout(() => {
            modal.style.opacity = '0';
            modal.addEventListener('transitionend', () => modal.remove());
        }, 3000);
    }

    /**
     * Displays a custom modal prompt instead of `prompt()`.
     * @param {string} message The message to display in the prompt.
     * @param {string} [defaultValue=''] The default value for the input field.
     * @returns {Promise<string|null>} A promise that resolves with the input value or null if canceled.
     */
    function customPrompt(message, defaultValue = '') {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            Object.assign(modal.style, {
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                padding: '20px',
                background: '#222',
                color: '#fff',
                borderRadius: '8px',
                boxShadow: '0 6px 15px rgba(0,0,0,0.4)',
                zIndex: '10002', // Higher z-index than message modal
                fontFamily: 'Inter, Arial, sans-serif',
                textAlign: 'center',
                minWidth: '300px',
                display: 'flex',
                flexDirection: 'column',
                gap: '15px',
                transition: 'opacity 0.3s ease-in-out',
                opacity: '0'
            });

            const textDiv = document.createElement('div');
            textDiv.textContent = message;
            textDiv.style.fontSize = '16px';
            modal.appendChild(textDiv);

            const input = document.createElement('input');
            input.type = 'text';
            input.value = defaultValue;
            Object.assign(input.style, {
                padding: '10px',
                borderRadius: '5px',
                border: '1px solid #555',
                background: '#333',
                color: '#fff',
                fontSize: '14px',
                outline: 'none'
            });
            modal.appendChild(input);

            const buttonContainer = document.createElement('div');
            Object.assign(buttonContainer.style, {
                display: 'flex',
                justifyContent: 'space-around',
                gap: '10px',
                marginTop: '10px'
            });

            const okBtn = document.createElement('button');
            okBtn.textContent = 'OK';
            Object.assign(okBtn.style, {
                padding: '10px 20px',
                cursor: 'pointer',
                color: '#fff',
                background: '#007bff',
                border: 'none',
                borderRadius: '5px',
                fontSize: '14px',
                flexGrow: '1'
            });
            okBtn.onmouseover = () => okBtn.style.background = '#0056b3';
            okBtn.onmouseout = () => okBtn.style.background = '#007bff';
            okBtn.onclick = () => {
                modal.style.opacity = '0';
                modal.addEventListener('transitionend', () => modal.remove());
                resolve(input.value);
            };
            buttonContainer.appendChild(okBtn);

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            Object.assign(cancelBtn.style, {
                padding: '10px 20px',
                cursor: 'pointer',
                color: '#fff',
                background: '#6c757d',
                border: 'none',
                borderRadius: '5px',
                fontSize: '14px',
                flexGrow: '1'
            });
            cancelBtn.onmouseover = () => cancelBtn.style.background = '#5a6268';
            cancelBtn.onmouseout = () => cancelBtn.style.background = '#6c757d';
            cancelBtn.onclick = () => {
                modal.style.opacity = '0';
                modal.addEventListener('transitionend', () => modal.remove());
                resolve(null);
            };
            buttonContainer.appendChild(cancelBtn);

            modal.appendChild(buttonContainer);
            document.body.appendChild(modal);

            // Fade in
            setTimeout(() => modal.style.opacity = '1', 10);

            input.focus();
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    okBtn.click();
                }
            });
        });
    }

    /**
     * Helper to create styled buttons for both UI panels.
     * @param {string} text The text content of the button.
     * @param {function} fn The click handler function.
     * @returns {HTMLButtonElement} The created button element.
     */
    function createStyledButton(text, fn) {
        const b = document.createElement('button');
        b.textContent = text;
        Object.assign(b.style, {
            padding: '10px',
            cursor: 'pointer',
            color: '#fff',
            background: '#3a3a3a', // Darker button background
            border: '1px solid #555',
            borderRadius: '5px', // Slightly more rounded
            transition: 'background 0.2s ease-in-out',
            fontSize: '14px'
        });
        b.onmouseover = () => b.style.background = '#505050'; // Hover effect
        b.onmouseout = () => b.style.background = '#3a3a3a';
        b.onclick = fn;
        return b;
    }

    /**
     * Creates and injects the AnnaUploader UI panel into the page.
     */
    function createUI() {
        // Assign to uiContainer for global access
        uiContainer = document.createElement('div');
        Object.assign(uiContainer.style, {
            position: 'fixed',
            top: '10px', // Initial top position
            right: '10px',
            width: '260px',
            background: '#1a1a1a', // Darker background
            border: '2px solid #333', // Subtle border
            color: '#e0e0e0', // Lighter text color
            padding: '15px',
            zIndex: 10000,
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)', // Stronger shadow
            display: 'flex',
            flexDirection: 'column',
            gap: '10px', // More spacing
            fontFamily: 'Inter, Arial, sans-serif', // Modern font
            transition: 'top 0.3s ease-in-out' // Smooth transition for top position
        });

        // Close button for the UI panel
        const close = createStyledButton('×', () => uiContainer.remove());
        Object.assign(close.style, {
            position: 'absolute',
            top: '5px',
            right: '8px',
            background: 'transparent',
            border: 'none',
            fontSize: '18px',
            color: '#e0e0e0',
            fontWeight: 'bold',
            transition: 'color 0.2s',
            padding: '5px 8px' // Make it easier to click
        });
        close.onmouseover = () => close.style.color = '#fff';
        close.onmouseout = () => close.style.color = '#e0e0e0';
        close.title = 'Close AnnaUploader';
        uiContainer.appendChild(close);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader';
        title.style.margin = '0 0 10px 0'; // More margin below title
        title.style.color = '#4af'; // Accent color for title
        title.style.textAlign = 'center';
        uiContainer.appendChild(title);

        // Upload T-Shirts button
        uiContainer.appendChild(createStyledButton('Upload T-Shirts', () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT);
            i.click();
        }));
        // Upload Decals button
        uiContainer.appendChild(createStyledButton('Upload Decals', () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL);
            i.click();
        }));
        // Upload Both button
        uiContainer.appendChild(createStyledButton('Upload Both', () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, null, true); // null means 'both'
            i.click();
        }));

        // Mass Upload toggle button
        toggleBtn = createStyledButton('Enable Mass Upload', () => {
            massMode = !massMode;
            toggleBtn.textContent = massMode ? 'Disable Mass Upload' : 'Enable Mass Upload';
            startBtn.style.display = massMode ? 'block' : 'none'; // Show/hide start button
            massQueue = []; // Clear queue when toggling mode
            batchTotal = completed = 0; // Reset progress
            updateStatus(); // Update status display
            displayMessage(`Mass Upload Mode: ${massMode ? 'Enabled' : 'Disabled'}`, 'info');
        });
        uiContainer.appendChild(toggleBtn);

        // Start Mass Upload button (initially hidden)
        startBtn = createStyledButton('Start Mass Upload', startMassUpload);
        startBtn.style.display = 'none';
        Object.assign(startBtn.style, {
            background: '#28a745', // Green for start
            border: '1px solid #218838'
        });
        startBtn.onmouseover = () => startBtn.style.background = '#218838';
        startBtn.onmouseout = () => startBtn.style.background = '#28a745';
        uiContainer.appendChild(startBtn);

        // Use default Name toggle
        const nameBtn = createStyledButton(`Use default Name: ${useForcedName ? 'On' : 'Off'}`, () => {
            useForcedName = !useForcedName;
            GM_setValue('useForcedName', useForcedName); // Save setting
            nameBtn.textContent = `Use default Name: ${useForcedName ? 'On' : 'Off'}`;
        });
        uiContainer.appendChild(nameBtn);

        // Slip Mode toggle
        const slipBtn = createStyledButton(`Slip Mode: ${useMakeUnique ? 'On' : 'Off'}`, () => {
            useMakeUnique = !useMakeUnique;
            GM_setValue('useMakeUnique', useMakeUnique); // Save setting
            slipBtn.textContent = `Slip Mode: ${useMakeUnique ? 'On' : 'Off'}`;
            copiesInput.style.display = useMakeUnique ? 'block' : 'none'; // Show/hide copies input
            downloadBtn.style.display = useMakeUnique ? 'block' : 'none'; // Show/hide download button

            // Adjust UI position based on Slip Mode (moved to settings for other options)
            // This specific UI adjustment might be less relevant now that pixel method is in settings.
            // Keeping it for now, but could be removed if it causes visual issues.
            if (useMakeUnique) {
                uiContainer.style.top = '0px'; // Move UI up to 0px from the top
            } else {
                uiContainer.style.top = '5px'; // Revert to original position
            }

            if (!useMakeUnique) { // If turning Slip Mode off, also turn off download
                useDownload = false;
                GM_setValue('useDownload', useDownload); // Save setting
                downloadBtn.textContent = 'Download Images: Off';
            }
        });
        uiContainer.appendChild(slipBtn);

        // Copies input for Slip Mode
        copiesInput = document.createElement('input');
        copiesInput.type = 'number'; copiesInput.min = '1'; copiesInput.value = uniqueCopies;
        Object.assign(copiesInput.style, {
            width: '100%',
            boxSizing: 'border-box',
            display: useMakeUnique ? 'block' : 'none', // Initially hidden based on setting
            padding: '8px',
            borderRadius: '4px',
            border: '1px solid #555',
            background: '#333',
            color: '#fff',
            textAlign: 'center'
        });
        copiesInput.onchange = e => {
            const v = parseInt(e.target.value, 10);
            if (v > 0) {
                uniqueCopies = v;
                GM_setValue('uniqueCopies', uniqueCopies); // Save setting
            }
            else e.target.value = uniqueCopies; // Revert to valid value if invalid input
        };
        uiContainer.appendChild(copiesInput);

        // Download Images toggle for Slip Mode
        downloadBtn = createStyledButton(`Download Images: ${useDownload ? 'On' : 'Off'}`, () => {
            useDownload = !useDownload;
            GM_setValue('useDownload', useDownload); // Save setting
            downloadBtn.textContent = `Download Images: ${useDownload ? 'On' : 'Off'}`;
        });
        downloadBtn.style.display = useMakeUnique ? 'block' : 'none'; // Initially hidden based on setting
        uiContainer.appendChild(downloadBtn);

        // Force Upload (through Canvas) toggle
        forceUploadBtn = createStyledButton(`Force Upload: ${useForceCanvasUpload ? 'On' : 'Off'}`, () => {
            useForceCanvasUpload = !useForceCanvasUpload;
            GM_setValue('useForceCanvasUpload', useForceCanvasUpload); // Save setting
            forceUploadBtn.textContent = `Force Upload: ${useForceCanvasUpload ? 'On' : 'Off'}`;
            displayMessage(`Force Upload Mode: ${useForceCanvasUpload ? 'Enabled' : 'Disabled'}`, 'info');
        });
        uiContainer.appendChild(forceUploadBtn);

        // Change ID button
        uiContainer.appendChild(createStyledButton('Change ID', async () => {
            const inp = await customPrompt("Enter your Roblox User ID/URL or Group URL:", USER_ID || '');
            if (inp === null) return; // User cancelled
            let id, isGrp = false;
            const um = inp.match(/users\/(\d+)/);
            const gm = inp.match(/communities\/(\d+)/);
            if (um) {
                id = um[1];
            } else if (gm) {
                id = gm[1];
                isGrp = true;
            } else {
                id = inp.trim();
                if (isNaN(id) || id === '') { // Check for empty string after trim as well
                    displayMessage('Invalid input. Please enter a number or a valid URL.', 'error');
                    return;
                }
            }
            USER_ID = Number(id);
            IS_GROUP = isGrp;
            GM_setValue('userId', USER_ID);
            GM_setValue('isGroup', IS_GROUP);
            displayMessage(`Set to ${isGrp ? 'Group' : 'User'} ID: ${USER_ID}`, 'success');
        }));

        // "Use This Profile as ID" button (contextual)
        const pm = window.location.pathname.match(/^\/users\/(\d+)\/profile/);
        if (pm) {
            uiContainer.appendChild(createStyledButton('Use This Profile as ID', () => {
                USER_ID = Number(pm[1]);
                IS_GROUP = false;
                GM_setValue('userId', USER_ID);
                GM_setValue('isGroup', IS_GROUP);
                displayMessage(`User ID set to ${USER_ID}`, 'success');
            }));
        }

        // "Use This Group as ID" button (contextual)
        const gm = window.location.pathname.match(/^\/communities\/(\d+)/);
        if (gm) {
            uiContainer.appendChild(createStyledButton('Use This Group as ID', () => {
                USER_ID = Number(gm[1]);
                IS_GROUP = true;
                GM_setValue('userId', USER_ID);
                GM_setValue('isGroup', IS_GROUP);
                displayMessage(`Group ID set to ${USER_ID}`, 'success');
            }));
        }

        // NEW: Settings button to open the settings modal
        uiContainer.appendChild(createStyledButton('Settings', () => {
            createSettingsUI();
        }));

        const hint = document.createElement('div');
        hint.textContent = 'Paste images (Ctrl+V) to queue/upload';
        hint.style.fontSize = '12px'; hint.style.color = '#aaa';
        hint.style.textAlign = 'center';
        hint.style.marginTop = '5px';
        uiContainer.appendChild(hint);

        // Status element at the bottom
        statusEl = document.createElement('div');
        statusEl.style.fontSize = '13px'; statusEl.style.color = '#fff';
        statusEl.style.textAlign = 'center';
        statusEl.style.paddingTop = '5px';
        statusEl.style.borderTop = '1px solid #333';
        uiContainer.appendChild(statusEl);

        document.body.appendChild(uiContainer);
    }

    /**
     * Creates and injects the AnnaUploader Settings UI modal into the page.
     */
    function createSettingsUI() {
        if (settingsModal) { // If settings modal already exists, just show it
            settingsModal.style.display = 'flex';
            return;
        }

        settingsModal = document.createElement('div');
        Object.assign(settingsModal.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '300px',
            background: '#1a1a1a', // Darker background
            border: '2px solid #333', // Subtle border
            color: '#e0e0e0', // Lighter text color
            padding: '20px',
            zIndex: 10005, // Higher than main UI
            borderRadius: '10px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.6)', // Stronger shadow
            display: 'flex',
            flexDirection: 'column',
            gap: '15px', // More spacing
            fontFamily: 'Inter, Arial, sans-serif', // Modern font
        });

        // Close button for the settings modal
        const closeSettings = createStyledButton('×', () => {
            settingsModal.style.display = 'none'; // Just hide, don't remove for re-opening
        });
        Object.assign(closeSettings.style, {
            position: 'absolute',
            top: '8px',
            right: '10px',
            background: 'transparent',
            border: 'none',
            fontSize: '20px',
            color: '#e0e0e0',
            fontWeight: 'bold',
            transition: 'color 0.2s',
            padding: '5px 10px'
        });
        closeSettings.onmouseover = () => closeSettings.style.color = '#fff';
        closeSettings.onmouseout = () => closeSettings.style.color = '#e0e0e0';
        closeSettings.title = 'Close Settings';
        settingsModal.appendChild(closeSettings);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader Settings';
        title.style.margin = '0 0 15px 0';
        title.style.color = '#4af';
        title.style.textAlign = 'center';
        settingsModal.appendChild(title);

        // NEW SETTING: Slip Mode Pixel Method
        const slipModePixelMethodLabel = document.createElement('label');
        slipModePixelMethodLabel.textContent = 'Slip Mode Pixel Method:';
        Object.assign(slipModePixelMethodLabel.style, {
            display: 'block',
            marginBottom: '5px',
            fontSize: '14px',
            color: '#bbb'
        });
        settingsModal.appendChild(slipModePixelMethodLabel);

        const slipModePixelMethodSelect = document.createElement('select');
        Object.assign(slipModePixelMethodSelect.style, {
            width: '100%',
            padding: '10px',
            borderRadius: '5px',
            border: '1px solid #555',
            background: '#333',
            color: '#fff',
            fontSize: '14px',
            outline: 'none',
            marginBottom: '10px'
        });

        const optionAll = document.createElement('option');
        optionAll.value = 'all_pixels';
        optionAll.textContent = 'All Pixels (±1)';
        slipModePixelMethodSelect.appendChild(optionAll);

        const optionRandom = document.createElement('option');
        optionRandom.value = '1-3_random';
        optionRandom.textContent = '1-3 Random Pixels (±1-3)';
        slipModePixelMethodSelect.appendChild(optionRandom);

        // Set current value
        slipModePixelMethodSelect.value = slipModePixelMethod;

        slipModePixelMethodSelect.onchange = (e) => {
            slipModePixelMethod = e.target.value;
            GM_setValue('slipModePixelMethod', slipModePixelMethod); // Save setting
            displayMessage(`Slip Mode Pixel Method set to: ${e.target.options[e.target.selectedIndex].text}`, 'success');
        };
        settingsModal.appendChild(slipModePixelMethodSelect);


        // Show Logged Assets button (moved from main UI)
        settingsModal.appendChild(createStyledButton('Show Logged Assets', () => {
            const log = loadLog();
            const entries = Object.entries(log);
            const w = window.open('', '_blank'); // Open a new blank window
            w.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Logged Assets</title>
<style>
body { font-family:Arial; padding:20px; background:#121212; color:#f0f0f0; }
h1 { margin-bottom:15px; color:#4af; }
ul { list-style:none; padding:0; }
li { margin-bottom:15px; padding:10px; background:#1e1e1e; border-radius:8px; display:flex; flex-direction:column; gap:8px;}
img { max-height:60px; border:1px solid #444; border-radius:4px; object-fit:contain; background:#333; }
.asset-info { display:flex;align-items:center;gap:15px; }
a { color:#7cf; text-decoration:none; font-weight:bold; }
a:hover { text-decoration:underline; }
.asset-name { font-size:0.9em; color:#bbb; margin-left: auto; text-align: right; }
button { margin-bottom:20px; color:#fff; background:#3a3a3a; border:1px solid #555; padding:8px 15px; border-radius:5px; cursor:pointer; }
button:hover { background:#505050; }
</style></head><body>
<button onclick="document.body.style.background=(document.body.style.background==='#121212'?'#f0f0f0':'#121212');document.body.style.color=(document.body.style.color==='#f0f0f0'?'#121212':'#f0f0f0');document.querySelectorAll('li').forEach(li=>li.style.background=(document.body.style.background==='#121212'?'#1e1e1e':'#e0e0e0'));document.querySelectorAll('a').forEach(a=>a.style.color=(document.body.style.background==='#121212'?'#7cf':'#007bff'));document.querySelectorAll('img').forEach(i=>i.style.border=(document.body.style.background==='#121212'?'1px solid #444':'1px solid #ccc'));">Toggle Theme</button>
<h1>Logged Assets</h1>
${ entries.length ? `<ul>${entries.map(([id,entry])=>
    `<li>
        <div class="asset-info">
            ${ entry.image ? `<img src="${entry.image}" alt="Asset thumbnail">`  : `<span style="color:#888;">(no image)</span>` }
            <a href="https://create.roblox.com/store/asset/${id}" target="_blank">${id}</a>
            <span style="font-size:0.85em; color:#999;">${new Date(entry.date).toLocaleString()}</span>
        </div>
        <div class="asset-name">${entry.name}</div>
    </li>`).join('') }</ul>` : `<p style="color:#888;"><em>No assets logged yet.</em></p>`}
</body></html>`);
            w.document.close(); // Close the document stream to ensure content is rendered
        }));

        document.body.appendChild(settingsModal);
    }

    /**
     * Handles paste events, attempting to extract image data and process it for upload.
     * @param {ClipboardEvent} e The paste event object.
     */
    async function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const it of items) {
            if (it.type.startsWith('image')) {
                e.preventDefault(); // Prevent default paste behavior
                const blob = it.getAsFile();
                const ts = new Date().toISOString().replace(/[^a-z0-9]/gi,'_'); // Timestamp for default name

                const pastedName = await customPrompt('Enter a name for the image (no extension):', `pasted_${ts}`);
                if (pastedName === null) return; // User cancelled
                let name = pastedName.trim() || `pasted_${ts}`;
                let filename = name.endsWith('.png') ? name : `${name}.png`; // Default to PNG

                let fileToProcess = new File([blob], filename, {type: blob.type});

                // 1. WebP Conversion (always happens first if needed)
                if (blob.type === 'image/webp') {
                    displayMessage(`Converting pasted WebP image to PNG...`, 'info');
                    try {
                        fileToProcess = await convertWebPToPng(fileToProcess);
                        // Update filename and type to reflect PNG
                        name = baseName(fileToProcess.name); // Get base name from the new PNG file
                        filename = fileToProcess.name; // Use the full name of the new PNG file
                        displayMessage(`Pasted WebP converted to PNG.`, 'success');
                    } catch (error) {
                        displayMessage(`Failed to convert pasted WebP: ${error.message}`, 'error');
                        console.error(`[Conversion] Failed to convert pasted WebP:`, error);
                        return; // Stop processing this paste if conversion fails
                    }
                }

                // 2. Force Canvas Upload (if enabled AND not already handled by makeUniqueFile)
                // For pasted images, makeUniqueFile is not directly called here, so always apply if force upload is on.
                if (useForceCanvasUpload) {
                    displayMessage(`Processing pasted image through canvas...`, 'info');
                    try {
                        fileToProcess = await processImageThroughCanvas(fileToProcess);
                        // Update filename and type to reflect PNG after canvas processing
                        name = baseName(fileToProcess.name);
                        filename = fileToProcess.name;
                        displayMessage(`Pasted image processed through canvas.`, 'success');
                    } catch (error) {
                        displayMessage(`Failed to process pasted image through canvas: ${error.message}`, 'error');
                        console.error(`[Canvas Process] Failed to process pasted image:`, error);
                        return; // Stop processing this paste if canvas processing fails
                    }
                }

                // Modified: Added 'B' option for 'both'
                const typeChoice = await customPrompt('Upload as T=T-Shirt, D=Decal, B=Both, or C=Cancel?', 'D');
                if (!typeChoice) return; // User cancelled
                const t = typeChoice.trim().toUpperCase();

                let uploadAsBoth = false;
                let type = null;

                if (t === 'T') {
                    type = ASSET_TYPE_TSHIRT;
                } else if (t === 'D') {
                    type = ASSET_TYPE_DECAL;
                } else if (t === 'B') {
                    uploadAsBoth = true;
                } else {
                    displayMessage('Invalid asset type selected. Please choose T, D, or B.', 'error');
                    return;
                }

                // Process the pasted file like any other selected file
                handleFileSelect([fileToProcess], type, uploadAsBoth);
                break; // Process only the first image found
            }
        }
    }

    // Initialize the UI and event listeners when the window loads
    window.addEventListener('load', () => {
        createUI();
        document.addEventListener('paste', handlePaste);
        scanForAssets(); // Initial scan
        console.log('[AnnaUploader] initialized; asset scan every ' + (SCAN_INTERVAL_MS/1000) + 's');
    });

})();
