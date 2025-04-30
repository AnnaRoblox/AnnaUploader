// ==UserScript==
// @name         AnnaUploader (Roblox Multi-File Uploader)
// @namespace    https://www.guilded.gg/u/AnnaBlox
// @version      3.4
// @description  Upload multiple T-Shirts/Decals easily with AnnaUploader
// @match        https://create.roblox.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @license MIT
// @downloadURL https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const ROBLOX_UPLOAD_URL = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT = 11;
    const ASSET_TYPE_DECAL  = 13;
    const UPLOAD_RETRY_DELAY = 2000;
    const MAX_RETRIES = 3;

    // ========== PERSISTENT USER CONFIG ========== //
    // Will default to this value only once, then store whatever you enter
    let USER_ID = GM_getValue('userId', 32456865);
    // ============================================ //

    let uploadQueue = [];
    let isUploading = false;
    let csrfToken = null;

    async function fetchCSRFToken() {
        try {
            const response = await fetch(ROBLOX_UPLOAD_URL, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            if (response.status === 403) {
                const token = response.headers.get('x-csrf-token');
                if (token) {
                    console.log('[CSRF] Token fetched:', token);
                    csrfToken = token;
                    return token;
                }
            }
            throw new Error('Failed to fetch CSRF token');
        } catch (error) {
            console.error('[CSRF] Fetch error:', error);
            throw error;
        }
    }

    async function uploadFile(file, assetType, retries = 0) {
        if (!csrfToken) {
            await fetchCSRFToken();
        }

        const formData = new FormData();
        formData.append("fileContent", file, file.name);
        formData.append("request", JSON.stringify({
            displayName: file.name.split('.')[0],
            description: "Uploaded Using AnnaUploader",
            assetType: assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal",
            creationContext: {
                creator: { userId: USER_ID },
                expectedPrice: 0
            }
        }));

        try {
            const response = await fetch(ROBLOX_UPLOAD_URL, {
                method: "POST",
                credentials: "include",
                headers: { "x-csrf-token": csrfToken },
                body: formData
            });

            if (response.ok) {
                console.log(`✅ Uploaded (${assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal"}): ${file.name}`);
            } else {
                const responseText = await response.text();
                console.error(`❌ Upload failed for ${file.name}: [${response.status}]`, responseText);

                if (response.status === 403 && retries < MAX_RETRIES) {
                    console.warn(`Fetching new CSRF and retrying ${file.name}...`);
                    csrfToken = null;
                    await new Promise(res => setTimeout(res, UPLOAD_RETRY_DELAY));
                    await uploadFile(file, assetType, retries + 1);
                } else {
                    throw new Error(`Failed to upload after ${retries} retries.`);
                }
            }
        } catch (error) {
            console.error(`Upload error for ${file.name}:`, error);
            throw error;
        }
    }

    async function processUploadQueue() {
        if (isUploading || uploadQueue.length === 0) return;
        isUploading = true;

        const { file, assetType } = uploadQueue.shift();
        try {
            await uploadFile(file, assetType);
        } catch (error) {
            console.error('Queue error:', error);
        } finally {
            isUploading = false;
            processUploadQueue();
        }
    }

    function handleFileSelect(files, assetType, uploadBoth = false) {
        if (!files || files.length === 0) {
            console.warn('No files selected.');
            return;
        }
        for (let i = 0; i < files.length; i++) {
            if (uploadBoth) {
                uploadQueue.push({ file: files[i], assetType: ASSET_TYPE_TSHIRT });
                uploadQueue.push({ file: files[i], assetType: ASSET_TYPE_DECAL });
                console.log(`Queued (Both): ${files[i].name}`);
            } else {
                uploadQueue.push({ file: files[i], assetType });
                console.log(`Queued (${assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal"}): ${files[i].name}`);
            }
        }
        processUploadQueue();
    }

    function createUploaderUI() {
        const container = document.createElement('div');
        container.style.position = 'fixed';
        container.style.top = '10px';
        container.style.right = '10px';
        container.style.backgroundColor = '#fff';
        container.style.border = '2px solid #000';
        container.style.padding = '15px';
        container.style.zIndex = '10000';
        container.style.borderRadius = '8px';
        container.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '10px';
        container.style.fontFamily = 'Arial, sans-serif';

        const title = document.createElement('h3');
        title.textContent = 'Multi-File Uploader';
        title.style.margin = '0';
        title.style.fontSize = '16px';
        container.appendChild(title);

        // Upload buttons
        const uploadTShirtBtn = document.createElement('button');
        uploadTShirtBtn.textContent = 'Upload T-Shirts';
        uploadTShirtBtn.style.padding = '8px';
        uploadTShirtBtn.style.cursor = 'pointer';
        uploadTShirtBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.addEventListener('change', e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT));
            input.click();
        });

        const uploadDecalBtn = document.createElement('button');
        uploadDecalBtn.textContent = 'Upload Decals';
        uploadDecalBtn.style.padding = '8px';
        uploadDecalBtn.style.cursor = 'pointer';
        uploadDecalBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.addEventListener('change', e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL));
            input.click();
        });

        const uploadBothBtn = document.createElement('button');
        uploadBothBtn.textContent = 'Upload Both';
        uploadBothBtn.style.padding = '8px';
        uploadBothBtn.style.cursor = 'pointer';
        uploadBothBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.addEventListener('change', e => handleFileSelect(e.target.files, null, true));
            input.click();
        });

        // Change ID button
        const changeIdBtn = document.createElement('button');
        changeIdBtn.textContent = 'Change ID';
        changeIdBtn.style.padding = '8px';
        changeIdBtn.style.cursor = 'pointer';
        changeIdBtn.addEventListener('click', () => {
            const newId = prompt("Enter your Roblox User ID:", USER_ID);
            if (newId && !isNaN(newId)) {
                USER_ID = Number(newId);
                GM_setValue('userId', USER_ID);
                alert(`User ID updated to ${USER_ID}`);
            } else {
                alert("Invalid ID. Please enter a numeric value.");
            }
        });

        const pasteHint = document.createElement('div');
        pasteHint.textContent = 'Paste images (Ctrl+V) to upload as decals!';
        pasteHint.style.fontSize = '12px';
        pasteHint.style.color = '#555';

        // Append everything
        container.appendChild(uploadTShirtBtn);
        container.appendChild(uploadDecalBtn);
        container.appendChild(uploadBothBtn);
        container.appendChild(changeIdBtn);
        container.appendChild(pasteHint);

        document.body.appendChild(container);
    }

    function handlePaste(event) {
        const items = event.clipboardData?.items;
        if (!items) return;

        let blob = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') === 0) {
                blob = items[i].getAsFile();
                break;
            }
        }

        if (blob) {
            event.preventDefault();
            const now = new Date();
            const filename = `pasted_image_${now.toISOString().replace(/[^a-z0-9]/gi, '_')}.png`;
            const file = new File([blob], filename, { type: blob.type });
            handleFileSelect([file], ASSET_TYPE_DECAL);
        }
    }

    function init() {
        createUploaderUI();
        document.addEventListener('paste', handlePaste);
        console.log('[Uploader] Initialized with User ID:', USER_ID);
    }

    window.addEventListener('load', init);
})();
