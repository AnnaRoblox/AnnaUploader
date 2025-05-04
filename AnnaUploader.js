// ==UserScript==
// @name         AnnaUploader (Roblox Multi-File Uploader)
// @namespace    https://www.guilded.gg/u/AnnaBlox
// @version      4.3
// @description  allows you to Upload multiple T-Shirts/Decals easily with AnnaUploader
// @match        https://create.roblox.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const ROBLOX_UPLOAD_URL  = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT  = 11;
    const ASSET_TYPE_DECAL   = 13;
    const UPLOAD_RETRY_DELAY = 12;
    const MAX_RETRIES        = 10;
    const FORCED_NAME_ON_MOD = "Uploaded Using AnnaUploader";

    let USER_ID        = GM_getValue('userId', null);
    let uploadQueue    = [];
    let isUploading    = false;
    let csrfToken      = null;
    let batchTotal     = 0;
    let completedCount = 0;
    let statusElement  = null;

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

    async function uploadFile(file, assetType, retries = 0, forceName = false) {
        if (!csrfToken) {
            await fetchCSRFToken();
        }

        const displayName = forceName
            ? FORCED_NAME_ON_MOD
            : file.name.split('.')[0];

        const formData = new FormData();
        formData.append("fileContent", file, file.name);
        formData.append("request", JSON.stringify({
            displayName: displayName,
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
                return;
            }

            const status = response.status;
            const text = await response.text();
            let json;
            try { json = JSON.parse(text); } catch {}

            const isModeratedName = status === 400 && json?.code === "INVALID_ARGUMENT" && json?.message?.includes("fully moderated");
            const isInvalidNameLength = status === 400 && json?.code === "INVALID_ARGUMENT" && json?.message?.includes("name length is invalid");

            if ((isModeratedName || isInvalidNameLength) && retries < MAX_RETRIES && !forceName) {
                console.warn(`⚠️ Invalid name for ${file.name}: retrying with forced name...`);
                await new Promise(res => setTimeout(res, UPLOAD_RETRY_DELAY));
                return await uploadFile(file, assetType, retries + 1, true);
            }

            if (status === 403 && retries < MAX_RETRIES) {
                console.warn(`🔄 CSRF expired for ${file.name}: fetching new token and retrying...`);
                csrfToken = null;
                await new Promise(res => setTimeout(res, UPLOAD_RETRY_DELAY));
                return await uploadFile(file, assetType, retries + 1, forceName);
            }

            console.error(`❌ Upload failed for ${file.name}: [${status}]`, text);
            throw new Error(`Failed to upload ${file.name} after ${retries} retries.`);
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
            completedCount++;
            updateStatus();
        } catch (e) {}
        finally {
            isUploading = false;
            processUploadQueue();
        }
    }

    function updateStatus() {
        if (!statusElement) return;
        if (batchTotal > 0) {
            statusElement.textContent = `${completedCount} of ${batchTotal} files uploaded successfully`;
        } else {
            statusElement.textContent = '';
        }
    }

    function handleFileSelect(files, assetType, uploadBoth = false) {
        if (!files || files.length === 0) {
            console.warn('No files selected.');
            return;
        }
        batchTotal = uploadBoth ? files.length * 2 : files.length;
        completedCount = 0;
        updateStatus();

        for (let file of files) {
            if (uploadBoth) {
                uploadQueue.push({ file, assetType: ASSET_TYPE_TSHIRT });
                uploadQueue.push({ file, assetType: ASSET_TYPE_DECAL });
                console.log(`Queued (Both): ${file.name}`);
            } else {
                uploadQueue.push({ file, assetType });
                console.log(`Queued (${assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal"}): ${file.name}`);
            }
        }
        processUploadQueue();
    }

    function createUploaderUI() {
        const container = document.createElement('div');
        Object.assign(container.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            backgroundColor: '#fff',
            border: '2px solid #000',
            padding: '15px',
            zIndex: '10000',
            borderRadius: '8px',
            boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            fontFamily: 'Arial, sans-serif',
            width: '200px'
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        Object.assign(closeBtn.style, {
            position: 'absolute',
            top: '5px',
            right: '8px',
            background: 'transparent',
            border: 'none',
            fontSize: '16px',
            cursor: 'pointer',
            lineHeight: '1'
        });
        closeBtn.title = 'Close uploader';
        closeBtn.addEventListener('click', () => container.remove());
        container.appendChild(closeBtn);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader';
        title.style.margin = '0 0 5px 0';
        title.style.fontSize = '16px';
        container.appendChild(title);

        const makeBtn = (text, onClick) => {
            const btn = document.createElement('button');
            btn.textContent = text;
            Object.assign(btn.style, { padding: '8px', cursor: 'pointer' });
            btn.addEventListener('click', onClick);
            return btn;
        };

        container.appendChild(makeBtn('Upload T-Shirts', () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
            input.addEventListener('change', e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT));
            input.click();
        }));
        container.appendChild(makeBtn('Upload Decals', () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
            input.addEventListener('change', e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL));
            input.click();
        }));
        container.appendChild(makeBtn('Upload Both', () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
            input.addEventListener('change', e => handleFileSelect(e.target.files, null, true));
            input.click();
        }));
        container.appendChild(makeBtn('Change ID', () => {
            const input = prompt("Enter your Roblox User ID or Profile URL:", USER_ID || '');
            if (!input) return;
            const urlMatch = input.match(/roblox\.com\/users\/(\d+)\/profile/i);
            let newId = urlMatch ? urlMatch[1] : (!isNaN(input.trim()) ? input.trim() : null);
            if (newId) {
                USER_ID = Number(newId);
                GM_setValue('userId', USER_ID);
                alert(`User ID updated to ${USER_ID}`);
            } else {
                alert("Invalid input. Please enter a numeric ID or a valid profile URL.");
            }
        }));

        const pasteHint = document.createElement('div');
        pasteHint.textContent = 'Paste images (Ctrl+V) to upload—name & type it first!';
        pasteHint.style.fontSize = '12px';
        pasteHint.style.color = '#555';
        container.appendChild(pasteHint);

        statusElement = document.createElement('div');
        statusElement.style.fontSize = '12px';
        statusElement.style.color = '#000';
        statusElement.textContent = '';
        container.appendChild(statusElement);

        document.body.appendChild(container);
    }

    function handlePaste(event) {
        const items = event.clipboardData?.items;
        if (!items) return;
        for (let item of items) {
            if (item.type.indexOf('image') === 0) {
                event.preventDefault();
                const blob = item.getAsFile();
                const now = new Date();
                const defaultBase = `pasted_image_${now.toISOString().replace(/[^a-z0-9]/gi, '_')}`;
                
                // 1) Name prompt
                let nameInput = prompt("Enter a name for the pasted image (no extension):", defaultBase);
                if (nameInput === null) return; // cancelled
                nameInput = nameInput.trim() || defaultBase;
                const filename = nameInput.endsWith('.png') ? nameInput : `${nameInput}.png`;

                // 2) Type prompt
                let typeInput = prompt(
                    "Upload as:\n  T = T-Shirt\n  D = Decal\n  C = Cancel",
                    "D"
                );
                if (!typeInput) return;
                typeInput = typeInput.trim().toUpperCase();
                let chosenType = null;
                if (typeInput === 'T') chosenType = ASSET_TYPE_TSHIRT;
                else if (typeInput === 'D') chosenType = ASSET_TYPE_DECAL;
                else return; // Cancel or invalid

                const file = new File([blob], filename, { type: blob.type });
                handleFileSelect([file], chosenType);
                break;
            }
        }
    }

    function init() {
        createUploaderUI();
        document.addEventListener('paste', handlePaste);
        console.log('[Uploader] Initialized with User ID:', USER_ID);
    }

    window.addEventListener('load', init);
})();
