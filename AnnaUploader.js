// ==UserScript==
// @name        AnnaUploader (Roblox Multi-File Uploader)
// @namespace   https://github.com/AnnaRoblox
// @version     8.1
// @description allows you to upload multiple T-Shirts Decals and audios easily with AnnaUploader
// @match       https://create.roblox.com/*
// @match       https://www.roblox.com/users/*/profile*
// @match       https://www.roblox.com/communities/*
// @match       https://www.roblox.com/home/*
// @run-at      document-idle
// @grant       GM_getValue
// @grant       GM_setValue
// @require     https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @require     https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js
// @downloadURL https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL   https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// @license     MIT
// ==/UserScript==

(function() {
    'use strict';

    const ROBLOX_UPLOAD_URL  = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT  = 11;
    const ASSET_TYPE_DECAL   = 13;
    const ASSET_TYPE_AUDIO   = 3;
    const FORCED_NAME        = "Uploaded Using AnnaUploader";
    const STORAGE_KEY = 'annaUploaderAssetLog';
    const SCAN_INTERVAL_MS = 10_000;

    let enableAssetLogging = GM_getValue('enableAssetLogging', false);
    let USER_ID       = GM_getValue('userId', null);
    let IS_GROUP      = GM_getValue('isGroup', false);
    let useForcedName = GM_getValue('useForcedName', false);
    let assetDescription = GM_getValue('assetDescription', "Uploaded Using AnnaUploader");
    let useMakeUnique = GM_getValue('useMakeUnique', false);
    let uniqueCopies  = GM_getValue('uniqueCopies', 1);
    let useDownload   = GM_getValue('useDownload', false);
    let useForceCanvasUpload = GM_getValue('useForceCanvasUpload', false);
    let slipModePixelMethod = GM_getValue('slipModePixelMethod', '1-3_random');
    let slipModeTemplate = GM_getValue('slipModeTemplate', 'default');
    let enableResize = GM_getValue('enableResize', false);
    let resizeWidth = GM_getValue('resizeWidth', 300);
    let resizeHeight = GM_getValue('resizeHeight', 300);

    let massMode    = false;
    let massQueue   = [];
    let batchTotal  = 0;
    let completed   = 0;
    let scanIntervalId = null;
    let csrfToken = null;

    let statusEl, toggleBtn, startBtn, copiesInput, downloadBtn;
    let uiContainer;
    let settingsModal;

    const MAX_CONCURRENT = 15;
    let activeUploads = 0;
    let globalRateLimitPromise = null;

    function getRandomString() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < Math.floor(Math.random() * 16) + 5; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        return result;
    }

    function baseName(filename) {
        return filename.replace(/\.[^/.]+$/, '');
    }

    function generateVariantName(origBase, i, copies, ext) {
        // If template is random, always return random
        if (slipModeTemplate === 'random') return `${getRandomString()}.${ext}`;
        // If only 1 copy and not random, return original name
        if (copies <= 1) return `${origBase}.${ext}`;

        switch (slipModeTemplate) {
            case 'same':
                return `${origBase}.${ext}`;
            case 'default':
            default:
                return `${origBase}_${i}.${ext}`;
        }
    }

    function loadLog() {
        const raw = GM_getValue(STORAGE_KEY, '{}');
        try { return JSON.parse(raw); } catch { return {}; }
    }

    function saveLog(log) {
        GM_setValue(STORAGE_KEY, JSON.stringify(log));
    }

    function logAsset(id, imageURL, name) {
        const log = loadLog();
        log[id] = {
            date: new Date().toISOString(),
            image: imageURL || log[id]?.image || null,
            name: name || log[id]?.name || '(unknown)'
        };
        saveLog(log);
        console.log(`[AssetLogger] logged asset ${id} at ${log[id].date}, name: ${log[id].name}`);
    }

    function scanForAssets() {
        console.log('[AssetLogger] scanning for assets...');
        document.querySelectorAll('[href]').forEach(el => {
            let m = el.href.match(/(?:https?:\/\/create\.roblox\.com)?\/store\/asset\/(\d+)/)
                 || el.href.match(/\/dashboard\/creations\/store\/(\d+)\/configure/);
            if (m) {
                const id = m[1];
                let image = null;
                const container = el.closest('*');
                const img = container?.querySelector('img');
                if (img?.src) image = img.src;

                let name = null;
                const nameEl = container?.querySelector('span.MuiTypography-root');
                if (nameEl) name = nameEl.textContent.trim();

                logAsset(id, image, name);
            }
        });
    }

    function toggleAssetScanner(enable) {
        if (enable && !scanIntervalId) {
            scanIntervalId = setInterval(scanForAssets, SCAN_INTERVAL_MS);
            console.log('[AssetLogger] Scanner started.');
        } else if (!enable && scanIntervalId) {
            clearInterval(scanIntervalId);
            scanIntervalId = null;
            console.log('[AssetLogger] Scanner stopped.');
        }
    }

    async function fetchCSRFToken() {
        const resp = await fetch(ROBLOX_UPLOAD_URL, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
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

    function updateStatus(customMsg) {
        if (!statusEl) return;
        if (customMsg) {
            statusEl.textContent = customMsg;
            return;
        }
        if (massMode) {
            statusEl.textContent = `${massQueue.length} queued for Mass Upload`;
        } else if (batchTotal > 0) {
            statusEl.textContent = `Completed ${completed} of ${batchTotal}...`;
        } else {
            statusEl.textContent = '';
        }
    }

    async function uploadFile(file, assetType, forceNameParam) {
        let forceName = forceNameParam;
        let retries = 0;
        while (true) {
            if (globalRateLimitPromise) {
                await globalRateLimitPromise;
            }
            if (!csrfToken) {
                try { await fetchCSRFToken(); }
                catch (e) { console.error("[Upload] Failed to fetch initial CSRF token:", e); return false; }
            }

            const displayName = forceName ? FORCED_NAME : baseName(file.name);
            const creator = IS_GROUP ? { groupId: USER_ID } : { userId: USER_ID };
            const fd = new FormData();
            fd.append('fileContent', file, file.name);
            fd.append('request', JSON.stringify({
                displayName,
                description: assetDescription,
                assetType: assetType === ASSET_TYPE_TSHIRT ? "TShirt" :
                           assetType === ASSET_TYPE_DECAL ? "Decal" :
                           assetType === ASSET_TYPE_AUDIO ? "Audio" : "Unknown",
                creationContext: { creator, expectedPrice: 0 }
            }));

            try {
                const resp = await fetch(ROBLOX_UPLOAD_URL, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'x-csrf-token': csrfToken },
                    body: fd
                });
                const txt = await resp.text();
                let json; try { json = JSON.parse(txt); } catch (e) { }

                if (resp.status === 429) {
                    console.warn(`[Upload] Rate limit hit for ${file.name}. Pausing system for 45s...`);
                    if (!globalRateLimitPromise) {
                        displayMessage(`Rate limited! Pausing system for 45s...`, 'error');
                        updateStatus(`Rate limited! Auto-resuming in 45s...`);
                        globalRateLimitPromise = new Promise(r => setTimeout(r, 45000)).then(() => {
                            globalRateLimitPromise = null;
                            displayMessage(`Resuming uploads!`, 'success');
                            updateStatus();
                        });
                    }
                    continue;
                }

                if (json?.message && typeof json.message === 'string' && json.message.toLowerCase().includes('banned')) {
                    displayMessage('Upload failed: Your account appears to be banned.', 'error');
                    return false;
                }

                if (resp.ok && json?.assetId) {
                    if (enableAssetLogging) logAsset(json.assetId, null, displayName);
                    return true;
                }
                if (json?.message === 'Asset name length is invalid.' && !forceName && retries < 5) {
                    retries++; forceName = true; continue;
                }
                if (resp.status === 400 && json?.message?.includes('moderated') && retries < 5) {
                    retries++; forceName = true; continue;
                }
                if (resp.status === 403 && retries < 5) {
                    csrfToken = null; retries++; continue;
                }
                console.error(`[Upload] failed "${file.name}" [${resp.status}]`, txt);
                return false;
            } catch (e) {
                console.error(`[Upload] error during fetch for "${file.name}":`, e);
                return false;
            }
        }
    }

    async function enqueueUpload(file, assetType, forceName) {
        while (activeUploads >= MAX_CONCURRENT) {
            await new Promise(r => setTimeout(r, 100));
        }
        activeUploads++;
        try {
            await uploadFile(file, assetType, forceName);
        } finally {
            activeUploads--;
            completed++;
            updateStatus();
        }
    }

    async function encodeWavChunked(audioBuffer, slipModeMethod) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        const buffer = new ArrayBuffer(44 + length * numChannels * 2);
        const view = new DataView(buffer);

        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + length * numChannels * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * 2, true);
        view.setUint16(32, numChannels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, length * numChannels * 2, true);

        const channels = [];
        for (let i = 0; i < numChannels; i++) channels.push(audioBuffer.getChannelData(i));

        let offsetIdx = 44;
        const LSB = 1 / 32768;
        const isAll = slipModeMethod === 'all_pixels';
        const is1to3 = slipModeMethod === '1-3_random';
        const chunkSize = 250000;

        for (let start = 0; start < length; start += chunkSize) {
            const end = Math.min(start + chunkSize, length);
            for (let i = start; i < end; i++) {
                let noise = 0;
                if (isAll) {
                    noise = (Math.random() < 0.5 ? -LSB : LSB);
                } else if (is1to3 && i % 20 === 0) {
                    noise = (Math.random() < 0.5 ? -LSB : LSB) * (Math.floor(Math.random() * 3) + 1);
                } else if (i % 250 === 0) {
                    noise = (Math.random() < 0.5 ? -LSB : LSB);
                }

                for (let ch = 0; ch < numChannels; ch++) {
                    let sample = channels[ch][i] + noise;
                    if (sample > 1) sample = 1; else if (sample < -1) sample = -1;
                    view.setInt16(offsetIdx, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                    offsetIdx += 2;
                }
            }
            await new Promise(r => setTimeout(r, 0));
        }
        return buffer;
    }

    async function makeAudioVariations(file, origBase, copies, useMakeUnique, slipModeMethod, onVariationGenerated) {
        const ext = file.name.split('.').pop() || 'mp3';
        if (!useMakeUnique) {
            for (let i = 1; i <= copies; i++) {
                const name = generateVariantName(origBase, i, copies, ext);
                onVariationGenerated(new File([file], name, { type: file.type }), i);
            }
            return;
        }

        const arrayBuffer = await file.arrayBuffer();
        let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        let decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        const projectedSize = 44 + decodedBuffer.length * decodedBuffer.numberOfChannels * 2;
        if (projectedSize > 19500000) {
            updateStatus(`Audio large! Auto-compressing to avoid 20MB limit...`);
            const targetSampleRate = 22050;
            const targetLength = Math.ceil(decodedBuffer.length * (targetSampleRate / decodedBuffer.sampleRate));
            const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, targetLength, targetSampleRate);
            const source = offlineCtx.createBufferSource();
            source.buffer = decodedBuffer;
            source.connect(offlineCtx.destination);
            source.start(0);
            decodedBuffer = await offlineCtx.startRendering();
        }

        for (let i = 1; i <= copies; i++) {
            updateStatus(`Preparing acoustic variation... (${i}/${copies})`);
            const wavBuffer = await encodeWavChunked(decodedBuffer, slipModeMethod);
            const newName = generateVariantName(origBase, i, copies, 'wav');
            onVariationGenerated(new File([wavBuffer], newName, { type: 'audio/wav' }), i);
        }
    }

    async function makeImageVariations(file, origBase, copies, useMakeUnique, slipModeMethod, useForceCanvasUpload, resizeW, resizeH, onVariationGenerated) {
        const img = new Image();
        const url = URL.createObjectURL(file);
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
            img.src = url;
        });
        URL.revokeObjectURL(url);

        let targetWidth = resizeW || img.width;
        let targetHeight = resizeH || img.height;

        const baseCanvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(targetWidth, targetHeight) : document.createElement('canvas');
        baseCanvas.width = targetWidth;
        baseCanvas.height = targetHeight;
        const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb', alpha: true });
        baseCtx.imageSmoothingEnabled = false;

        try {
            const bitmap = await createImageBitmap(img);
            baseCtx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        } catch (e) {
            baseCtx.drawImage(img, 0, 0, targetWidth, targetHeight);
        }

        if (!useMakeUnique) {
            const ext = file.type.split('/')[1] || 'png';
            if (!useForceCanvasUpload && !resizeW && !resizeH && (file.type === 'image/png' || file.type === 'image/jpeg')) {
                for(let i=1; i<=copies; i++){
                    const name = generateVariantName(origBase, i, copies, ext);
                    onVariationGenerated(new File([file], name, { type: file.type }), i);
                }
                return;
            }
            const blob = await new Promise(res => {
                if (baseCanvas.toBlob) baseCanvas.toBlob(res, 'image/png');
                else baseCanvas.convertToBlob({ type: 'image/png' }).then(res);
            });
            for(let i=1; i<=copies; i++){
                const name = generateVariantName(origBase, i, copies, 'png');
                onVariationGenerated(new File([blob], name, { type: 'image/png' }), i);
            }
            return;
        }

        let baseImageData = null;
        if (slipModeMethod !== 'random_resize' && !slipModeMethod.includes('single_pixel')) {
            baseImageData = baseCtx.getImageData(0, 0, targetWidth, targetHeight);
        }

        for (let i = 1; i <= copies; i++) {
            updateStatus(`Preparing image copy... (${i}/${copies})`);
            await new Promise(r => setTimeout(r, 0));

            let currentW = targetWidth;
            let currentH = targetHeight;
            let targetCanvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(currentW, currentH) : document.createElement('canvas');

            if (slipModeMethod === 'random_resize') {
                currentW = Math.max(1, targetWidth + (Math.floor(Math.random() * 11) - 5));
                currentH = Math.max(1, targetHeight + (Math.floor(Math.random() * 11) - 5));
                targetCanvas.width = currentW;
                targetCanvas.height = currentH;
                const tCtx = targetCanvas.getContext('2d');
                tCtx.imageSmoothingEnabled = false;
                tCtx.drawImage(baseCanvas, 0, 0, currentW, currentH);
            } else if (slipModeMethod.includes('single_pixel')) {
                targetCanvas.width = currentW;
                targetCanvas.height = currentH;
                const tCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
                tCtx.drawImage(baseCanvas, 0, 0);
                const x = Math.floor(Math.random() * currentW);
                const y = Math.floor(Math.random() * currentH);
                if (slipModeMethod === '1-4_random_single_pixel') {
                    const original = tCtx.getImageData(x, y, 1, 1);
                    const d = original.data;
                    const delta = (Math.random() < 0.5 ? -1 : 1) * (Math.floor(Math.random() * 4) + 1);
                    d[0] = Math.min(255, Math.max(0, d[0] + delta));
                    d[1] = Math.min(255, Math.max(0, d[1] + delta));
                    d[2] = Math.min(255, Math.max(0, d[2] + delta));
                    d[3] = d[3] === 0 ? 1 : d[3];
                    tCtx.putImageData(original, x, y);
                } else {
                    const singlePixel = tCtx.createImageData(1, 1);
                    const d = singlePixel.data;
                    d[0] = Math.floor(Math.random() * 256);
                    d[1] = Math.floor(Math.random() * 256);
                    d[2] = Math.floor(Math.random() * 256);
                    d[3] = slipModeMethod === 'random_single_pixel_alpha_0' ? 0 : 255;
                    tCtx.putImageData(singlePixel, x, y);
                }
            } else {
                targetCanvas.width = currentW;
                targetCanvas.height = currentH;
                const tCtx = targetCanvas.getContext('2d');
                const newImageData = new ImageData(
                    new Uint8ClampedArray(baseImageData.data),
                    baseImageData.width,
                    baseImageData.height
                );
                const data = newImageData.data;
                const is1to3 = slipModeMethod === '1-3_random';
                const chunkSize = 1000000;
                for (let cStart = 0; cStart < data.length; cStart += chunkSize) {
                    const cEnd = Math.min(cStart + chunkSize, data.length);
                    for (let j = cStart; j < cEnd; j += 4) {
                        if (data[j + 3] !== 0) {
                            const delta = (Math.random() < 0.5 ? -1 : 1) * (is1to3 ? Math.floor(Math.random() * 3) + 1 : 1);
                            let r = data[j] + delta; let g = data[j+1] + delta; let b = data[j+2] + delta;
                            if (r > 255) r = 255; else if (r < 0) r = 0;
                            if (g > 255) g = 255; else if (g < 0) g = 0;
                            if (b > 255) b = 255; else if (b < 0) b = 0;
                            data[j] = r; data[j+1] = g; data[j+2] = b;
                        }
                    }
                    await new Promise(r => setTimeout(r, 0));
                }
                tCtx.putImageData(newImageData, 0, 0);
            }

            const blob = await new Promise(res => {
                if (targetCanvas.toBlob) targetCanvas.toBlob(res, 'image/png');
                else targetCanvas.convertToBlob({ type: 'image/png' }).then(res);
            });
            const newName = generateVariantName(origBase, i, copies, 'png');
            onVariationGenerated(new File([blob], newName, { type: 'image/png' }), i);
        }
    }

    async function handleFileSelect(files, assetType, both = false) {
        if (!files?.length) return;
        const downloadsMap = {};
        const copies = useMakeUnique ? uniqueCopies : 1;
        const resizeActive = enableResize && Number(resizeWidth) > 0 && Number(resizeHeight) > 0;
        const isAudio = assetType === ASSET_TYPE_AUDIO;
        const allFilesToProcess = Array.from(files);

        batchTotal = allFilesToProcess.length * (both ? 2 : 1) * copies;
        completed = 0;
        updateStatus();

        if (massMode) {
            displayMessage(`Adding ${batchTotal} files to Mass Queue...`, 'info');
        } else {
            displayMessage(`Starting pipeline for ${batchTotal} files...`, 'info');
        }

        const uploadPromises = [];
        for (const original of allFilesToProcess) {
            const origBase = baseName(original.name);
            const collectedVariations = [];

            const handleVariationReady = (fileToUpload) => {
                collectedVariations.push(fileToUpload);
                if (massMode) {
                    if (both) {
                        massQueue.push({ f: fileToUpload, type: ASSET_TYPE_TSHIRT, forceName: useForcedName });
                        massQueue.push({ f: fileToUpload, type: ASSET_TYPE_DECAL, forceName: useForcedName });
                        updateStatus();
                    } else {
                        massQueue.push({ f: fileToUpload, type: assetType, forceName: useForcedName });
                        updateStatus();
                    }
                } else {
                    if (both) {
                        uploadPromises.push(enqueueUpload(fileToUpload, ASSET_TYPE_TSHIRT, useForcedName));
                        uploadPromises.push(enqueueUpload(fileToUpload, ASSET_TYPE_DECAL, useForcedName));
                    } else {
                        uploadPromises.push(enqueueUpload(fileToUpload, assetType, useForcedName));
                    }
                }
            };

            let base = origBase;
            if (!isAudio && original.name.toLowerCase().endsWith('.webp')) base = origBase.replace(/\.webp$/i, '');

            try {
                if (isAudio) {
                    await makeAudioVariations(original, origBase, copies, useMakeUnique, slipModePixelMethod, handleVariationReady);
                } else {
                    await makeImageVariations(
                        original, base, copies, useMakeUnique, slipModePixelMethod,
                        useForceCanvasUpload,
                        resizeActive ? Number(resizeWidth) : null,
                        resizeActive ? Number(resizeHeight) : null,
                        handleVariationReady
                    );
                }
            } catch (error) {
                displayMessage(`Failed to process ${original.name}: ${error.message}`, 'error');
                console.error(error);
                continue;
            }

            if (useMakeUnique && useDownload) {
                downloadsMap[origBase] = collectedVariations;
            }
        }

        if (massMode) {
            displayMessage(`Added successfully to mass queue!`, 'success');
        } else {
            Promise.all(uploadPromises).then(() => {
                if (enableAssetLogging) scanForAssets();
                displayMessage('Upload batch complete!', 'success');

                if (useMakeUnique && useDownload) {
                    for (const [origBase, fileList] of Object.entries(downloadsMap)) {
                        if (!fileList.length) continue;
                        const zip = new JSZip();
                        fileList.forEach((f, idx) => {
                            let zipFileName = f.name;
                            if (slipModeTemplate === 'same' && fileList.length > 1) {
                                const ext = f.name.split('.').pop();
                                zipFileName = `${baseName(f.name)}_${idx + 1}.${ext}`;
                            }
                            zip.file(zipFileName, f);
                        });
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
                console.error("Upload batch encountered an error:", error);
                displayMessage('Upload batch finished with errors. Check console.', 'error');
            });
        }
    }

    function startMassUpload() {
        if (!massQueue.length) {
            displayMessage('Nothing queued for mass upload!', 'info');
            return;
        }
        displayMessage(`Starting mass upload of ${massQueue.length} files...`, 'info');
        batchTotal = massQueue.length;
        completed = 0;
        const tasks = [...massQueue];
        massQueue = [];
        startBtn.style.display = 'none';
        massMode = false;
        toggleBtn.textContent = 'Enable Mass Upload';

        const promises = tasks.map(task => enqueueUpload(task.f, task.type, task.forceName));
        Promise.all(promises).then(() => {
            displayMessage('Mass upload complete!', 'success');
            if (enableAssetLogging) scanForAssets();
            batchTotal = completed = 0;
            updateStatus();
        }).catch(error => {
            console.error("Mass upload encountered an error:", error);
            displayMessage('Mass upload finished with errors. Check console.', 'error');
            batchTotal = completed = 0;
            updateStatus();
        });
    }

    function displayMessage(message, type = 'info') {
        const modal = document.createElement('div');
        Object.assign(modal.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            padding: '20px', background: '#333', color: '#fff', borderRadius: '8px',
            boxShadow: '0 4px 10px rgba(0,0,0,0.5)', zIndex: '10001',
            fontFamily: 'Inter, Arial, sans-serif', textAlign: 'center',
            minWidth: '250px', transition: 'opacity 0.3s ease-in-out', opacity: '0'
        });
        if (type === 'success') modal.style.background = '#4CAF50';
        else if (type === 'error') modal.style.background = '#f44336';
        modal.textContent = message;
        document.body.appendChild(modal);
        setTimeout(() => modal.style.opacity = '1', 10);
        setTimeout(() => {
            modal.style.opacity = '0';
            modal.addEventListener('transitionend', () => modal.remove());
        }, 3000);
    }

    function customPrompt(message, defaultValue = '') {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            Object.assign(modal.style, {
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                padding: '20px', background: '#222', color: '#fff', borderRadius: '8px',
                boxShadow: '0 6px 15px rgba(0,0,0,0.4)', zIndex: '10002',
                fontFamily: 'Inter, Arial, sans-serif', textAlign: 'center',
                minWidth: '300px', display: 'flex', flexDirection: 'column',
                gap: '15px', transition: 'opacity 0.3s ease-in-out', opacity: '0'
            });
            const textDiv = document.createElement('div');
            textDiv.textContent = message;
            textDiv.style.fontSize = '16px';
            modal.appendChild(textDiv);
            const input = document.createElement('input');
            input.type = 'text'; input.value = defaultValue;
            Object.assign(input.style, {
                padding: '10px', borderRadius: '5px', border: '1px solid #555',
                background: '#333', color: '#fff', fontSize: '14px', outline: 'none'
            });
            modal.appendChild(input);
            const buttonContainer = document.createElement('div');
            Object.assign(buttonContainer.style, { display: 'flex', justifyContent: 'space-around', gap: '10px', marginTop: '10px' });
            const okBtn = document.createElement('button');
            okBtn.textContent = 'OK';
            Object.assign(okBtn.style, { padding: '10px 20px', cursor: 'pointer', color: '#fff', background: '#007bff', border: 'none', borderRadius: '5px', fontSize: '14px', flexGrow: '1' });
            okBtn.onclick = () => {
                modal.style.opacity = '0';
                modal.addEventListener('transitionend', () => modal.remove());
                resolve(input.value);
            };
            buttonContainer.appendChild(okBtn);
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            Object.assign(cancelBtn.style, { padding: '10px 20px', cursor: 'pointer', color: '#fff', background: '#6c757d', border: 'none', borderRadius: '5px', fontSize: '14px', flexGrow: '1' });
            cancelBtn.onclick = () => {
                modal.style.opacity = '0';
                modal.addEventListener('transitionend', () => modal.remove());
                resolve(null);
            };
            buttonContainer.appendChild(cancelBtn);
            modal.appendChild(buttonContainer);
            document.body.appendChild(modal);
            setTimeout(() => modal.style.opacity = '1', 10);
            input.focus();
            input.addEventListener('keypress', (e) => { if (e.key === 'Enter') okBtn.click(); });
        });
    }

    function createStyledButton(text, fn) {
        const b = document.createElement('button');
        b.textContent = text;
        Object.assign(b.style, { padding: '10px', cursor: 'pointer', color: '#fff', background: '#3a3a3a', border: '1px solid #555', borderRadius: '5px', transition: 'background 0.2s ease-in-out', fontSize: '14px' });
        b.onmouseover = () => b.style.background = '#505050';
        b.onmouseout = () => b.style.background = '#3a3a3a';
        b.onclick = fn;
        return b;
    }

    function createUI() {
        uiContainer = document.createElement('div');
        Object.assign(uiContainer.style, {
            position: 'fixed', top: '10px', right: '10px', width: '280px',
            background: '#1a1a1a', border: '2px solid #333', color: '#e0e0e0',
            padding: '15px 15px 15px 15px', zIndex: 10000, borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column',
            gap: '10px', fontFamily: 'Inter, Arial, sans-serif', transition: 'top 0.3s ease-in-out'
        });

        const close = createStyledButton('×', () => uiContainer.remove());
        Object.assign(close.style, { position: 'absolute', top: '5px', right: '8px', background: 'transparent', border: 'none', fontSize: '18px', color: '#e0e0e0', fontWeight: 'bold', transition: 'color 0.2s', padding: '5px 8px' });
        close.title = 'Close AnnaUploader';
        uiContainer.appendChild(close);

        const settingsGear = createStyledButton('⚙️', () => {
            if (settingsModal && settingsModal.style.display !== 'none') {
                settingsModal.style.display = 'none';
            } else {
                createSettingsUI();
            }
        });
        Object.assign(settingsGear.style, { position: 'absolute', top: '5px', left: '8px', background: 'transparent', border: 'none', fontSize: '18px', color: '#e0e0e0', fontWeight: 'bold', transition: 'color 0.2s', padding: '5px 8px' });
        settingsGear.title = 'Settings';
        uiContainer.appendChild(settingsGear);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader';
        title.style.margin = '0 0 10px 0';
        title.style.color = '#4af';
        title.style.textAlign = 'center';
        uiContainer.appendChild(title);

        uiContainer.appendChild(createStyledButton('Upload T-Shirts', () => {
            const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT); i.click();
        }));
        uiContainer.appendChild(createStyledButton('Upload Decals', () => {
            const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL); i.click();
        }));
        uiContainer.appendChild(createStyledButton('Upload Both', () => {
            const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, null, true); i.click();
        }));
        uiContainer.appendChild(createStyledButton('Upload Audio', () => {
            const i = document.createElement('input'); i.type = 'file'; i.accept = 'audio/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_AUDIO); i.click();
        }));

        toggleBtn = createStyledButton('Enable Mass Upload', () => {
            massMode = !massMode;
            toggleBtn.textContent = massMode ? 'Disable Mass Upload' : 'Enable Mass Upload';
            startBtn.style.display = massMode ? 'block' : 'none';
            massQueue = []; batchTotal = completed = 0;
            updateStatus();
            displayMessage(`Mass Upload Mode: ${massMode ? 'Enabled' : 'Disabled'}`, 'info');
        });
        uiContainer.appendChild(toggleBtn);

        startBtn = createStyledButton('Start Mass Upload', startMassUpload);
        startBtn.style.display = 'none';
        Object.assign(startBtn.style, { background: '#28a745', border: '1px solid #218838' });
        uiContainer.appendChild(startBtn);

        const slipBtn = createStyledButton(`Slip Mode: ${useMakeUnique ? 'On' : 'Off'}`, () => {
            useMakeUnique = !useMakeUnique;
            GM_setValue('useMakeUnique', useMakeUnique);
            slipBtn.textContent = `Slip Mode: ${useMakeUnique ? 'On' : 'Off'}`;
            copiesInput.style.display = useMakeUnique ? 'block' : 'none';
            downloadBtn.style.display = useMakeUnique ? 'block' : 'none';
            if (!useMakeUnique) {
                useDownload = false;
                GM_setValue('useDownload', useDownload);
                downloadBtn.textContent = 'Download Assets: Off';
            }
        });
        uiContainer.appendChild(slipBtn);

        copiesInput = document.createElement('input');
        copiesInput.type = 'number'; copiesInput.min = '1'; copiesInput.value = uniqueCopies;
        Object.assign(copiesInput.style, { width: '100%', boxSizing: 'border-box', display: useMakeUnique ? 'block' : 'none', padding: '8px', borderRadius: '4px', border: '1px solid #555', background: '#333', color: '#fff', textAlign: 'center' });
        copiesInput.onchange = e => {
            const v = parseInt(e.target.value, 10);
            if (v > 0) { uniqueCopies = v; GM_setValue('uniqueCopies', uniqueCopies); }
            else e.target.value = uniqueCopies;
        };
        uiContainer.appendChild(copiesInput);

        downloadBtn = createStyledButton(`Download Assets: ${useDownload ? 'On' : 'Off'}`, () => {
            useDownload = !useDownload;
            GM_setValue('useDownload', useDownload);
            downloadBtn.textContent = `Download Assets: ${useDownload ? 'On' : 'Off'}`;
        });
        downloadBtn.style.display = useMakeUnique ? 'block' : 'none';
        uiContainer.appendChild(downloadBtn);

        uiContainer.appendChild(createStyledButton('Change ID', async () => {
            const inp = await customPrompt("Enter your Roblox User ID/URL or Group URL:", USER_ID || '');
            if (inp === null) return;
            let id, isGrp = false;
            const um = inp.match(/users\/(\d+)/);
            const gm = inp.match(/communities\/(\d+)/);
            if (um) id = um[1];
            else if (gm) { id = gm[1]; isGrp = true; }
            else {
                id = inp.trim();
                if (isNaN(id) || id === '') { displayMessage('Invalid input.', 'error'); return; }
            }
            USER_ID = Number(id);
            IS_GROUP = isGrp;
            GM_setValue('userId', USER_ID); GM_setValue('isGroup', IS_GROUP);
            displayMessage(`Set to ${isGrp ? 'Group' : 'User'} ID: ${USER_ID}`, 'success');
        }));

        const pm = window.location.pathname.match(/^\/users\/(\d+)\/profile/);
        if (pm) {
            uiContainer.appendChild(createStyledButton('Use This Profile as ID', () => {
                USER_ID = Number(pm[1]); IS_GROUP = false;
                GM_setValue('userId', USER_ID); GM_setValue('isGroup', IS_GROUP);
                displayMessage(`User ID set to ${USER_ID}`, 'success');
            }));
        }
        const gm = window.location.pathname.match(/^\/communities\/(\d+)/);
        if (gm) {
            uiContainer.appendChild(createStyledButton('Use This Group as ID', () => {
                USER_ID = Number(gm[1]); IS_GROUP = true;
                GM_setValue('userId', USER_ID); GM_setValue('isGroup', IS_GROUP);
                displayMessage(`Group ID set to ${USER_ID}`, 'success');
            }));
        }

        const hint = document.createElement('div');
        hint.textContent = 'Paste images (Ctrl+V) to queue/upload or select files';
        hint.style.fontSize = '12px'; hint.style.color = '#aaa'; hint.style.textAlign = 'center'; hint.style.marginTop = '5px';
        uiContainer.appendChild(hint);

        statusEl = document.createElement('div');
        statusEl.style.fontSize = '13px'; statusEl.style.color = '#fff'; statusEl.style.textAlign = 'center';
        statusEl.style.paddingTop = '5px'; statusEl.style.borderTop = '1px solid #333';
        uiContainer.appendChild(statusEl);

        document.body.appendChild(uiContainer);
    }

    function createSettingsUI() {
        if (settingsModal) { settingsModal.style.display = 'flex'; return; }
        settingsModal = document.createElement('div');
        Object.assign(settingsModal.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: '320px', maxHeight: '90vh', overflowY: 'auto',
            background: '#1a1a1a', border: '2px solid #333', color: '#e0e0e0',
            padding: '15px', zIndex: 10005, borderRadius: '10px', boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', gap: '10px', fontFamily: 'Inter, Arial, sans-serif'
        });

        const closeSettings = createStyledButton('×', () => settingsModal.style.display = 'none');
        Object.assign(closeSettings.style, { position: 'absolute', top: '8px', right: '10px', background: 'transparent', border: 'none', fontSize: '20px', color: '#e0e0e0', fontWeight: 'bold', transition: 'color 0.2s', padding: '5px 10px' });
        settingsModal.appendChild(closeSettings);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader Settings';
        title.style.margin = '0 0 5px 0'; title.style.color = '#4af'; title.style.textAlign = 'center';
        settingsModal.appendChild(title);

        const nameBtn = createStyledButton(`Use default Name: ${useForcedName ? 'On' : 'Off'}`, () => {
            useForcedName = !useForcedName; GM_setValue('useForcedName', useForcedName);
            nameBtn.textContent = `Use default Name: ${useForcedName ? 'On' : 'Off'}`;
        });
        settingsModal.appendChild(nameBtn);

        const assetLoggingBtn = createStyledButton(`Asset Logging: ${enableAssetLogging ? 'On' : 'Off'}`, () => {
            enableAssetLogging = !enableAssetLogging; GM_setValue('enableAssetLogging', enableAssetLogging);
            assetLoggingBtn.textContent = `Asset Logging: ${enableAssetLogging ? 'On' : 'Off'}`;
            toggleAssetScanner(enableAssetLogging);
            displayMessage(`Asset Logging: ${enableAssetLogging ? 'Enabled' : 'Disabled'}`, 'info');
        });
        settingsModal.appendChild(assetLoggingBtn);

        const descLabel = document.createElement('label');
        descLabel.textContent = 'Asset Description:';
        Object.assign(descLabel.style, { display: 'block', fontSize: '13px', color: '#bbb', marginBottom: '2px' });
        settingsModal.appendChild(descLabel);

        const descInput = document.createElement('textarea');
        descInput.value = assetDescription;
        Object.assign(descInput.style, {
            width: '100%',
            padding: '8px',
            borderRadius: '5px',
            border: '1px solid #555',
            background: '#333',
            color: '#fff',
            fontSize: '13px',
            lineHeight: '1.4',
            outline: 'none',
            boxSizing: 'border-box',
            resize: 'none',
            fontFamily: 'inherit',
            overflow: 'hidden',
            minHeight: '40px',
            flexShrink: '0',
            display: 'block'
        });

        const autoResize = () => {
            descInput.style.height = 'auto';
            // We add a tiny buffer (2px) to account for borders when using border-box
            descInput.style.height = (descInput.scrollHeight + 2) + 'px';
        };

        descInput.oninput = autoResize;
        descInput.onchange = (e) => {
            assetDescription = e.target.value;
            GM_setValue('assetDescription', assetDescription);
        };
        settingsModal.appendChild(descInput);

        // Use a more reliable trigger for initial sizing
        setTimeout(autoResize, 50);
        // Also listen for window resize just in case
        window.addEventListener('resize', autoResize);

        const slipModeTemplateLabel = document.createElement('label');
        slipModeTemplateLabel.textContent = 'SlipMode Template:';
        Object.assign(slipModeTemplateLabel.style, { display: 'block', marginBottom: '2px', fontSize: '13px', color: '#bbb' });
        settingsModal.appendChild(slipModeTemplateLabel);

        const slipModeTemplateSelect = document.createElement('select');
        Object.assign(slipModeTemplateSelect.style, { width: '100%', padding: '8px', borderRadius: '5px', border: '1px solid #555', background: '#333', color: '#fff', fontSize: '13px', outline: 'none', marginBottom: '2px' });

        const tplDefault = document.createElement('option'); tplDefault.value = 'default'; tplDefault.textContent = 'Default (name_1)'; slipModeTemplateSelect.appendChild(tplDefault);
        const tplRandom = document.createElement('option'); tplRandom.value = 'random'; tplRandom.textContent = 'Random Name'; slipModeTemplateSelect.appendChild(tplRandom);
        const tplSame = document.createElement('option'); tplSame.value = 'same'; tplSame.textContent = 'Same Name'; slipModeTemplateSelect.appendChild(tplSame);

        slipModeTemplateSelect.value = slipModeTemplate;
        slipModeTemplateSelect.onchange = (e) => {
            slipModeTemplate = e.target.value; GM_setValue('slipModeTemplate', slipModeTemplate);
            displayMessage(`Template set to: ${e.target.options[e.target.selectedIndex].text}`, 'success');
        };
        settingsModal.appendChild(slipModeTemplateSelect);

        const slipModePixelMethodLabel = document.createElement('label');
        slipModePixelMethodLabel.textContent = 'Slip Mode Pixel Method:';
        Object.assign(slipModePixelMethodLabel.style, { display: 'block', marginBottom: '2px', fontSize: '13px', color: '#bbb' });
        settingsModal.appendChild(slipModePixelMethodLabel);

        const slipModePixelMethodSelect = document.createElement('select');
        Object.assign(slipModePixelMethodSelect.style, { width: '100%', padding: '8px', borderRadius: '5px', border: '1px solid #555', background: '#333', color: '#fff', fontSize: '13px', outline: 'none', marginBottom: '5px' });
        const optionAll = document.createElement('option'); optionAll.value = 'all_pixels'; optionAll.textContent = 'All Pixels (±1) [Slow on >300px]'; slipModePixelMethodSelect.appendChild(optionAll);
        const optionRandom = document.createElement('option'); optionRandom.value = '1-3_random'; optionRandom.textContent = 'Random Pixels (±1-3) [Slow on >300px]'; slipModePixelMethodSelect.appendChild(optionRandom);
        const optionSingleRandom = document.createElement('option'); optionSingleRandom.value = '1-4_random_single_pixel'; optionSingleRandom.textContent = 'Single Random Pixel (Fastest)'; slipModePixelMethodSelect.appendChild(optionSingleRandom);
        const optionFullRandomSinglePixel = document.createElement('option'); optionFullRandomSinglePixel.value = 'random_single_pixel_full_random_color'; optionFullRandomSinglePixel.textContent = 'Single Random Pixel (Full Color) (Fastest)'; slipModePixelMethodSelect.appendChild(optionFullRandomSinglePixel);
        const optionAlpha0SinglePixel = document.createElement('option'); optionAlpha0SinglePixel.value = 'random_single_pixel_alpha_0'; optionAlpha0SinglePixel.textContent = 'Single Random Pixel (Random Color, Alpha 0) (Fastest)'; slipModePixelMethodSelect.appendChild(optionAlpha0SinglePixel);
        const optionRandomResize = document.createElement('option'); optionRandomResize.value = 'random_resize'; optionRandomResize.textContent = 'Random Resize (Unique Dimensions) (Fastest)'; slipModePixelMethodSelect.appendChild(optionRandomResize);
        slipModePixelMethodSelect.value = slipModePixelMethod;
        slipModePixelMethodSelect.onchange = (e) => {
            slipModePixelMethod = e.target.value; GM_setValue('slipModePixelMethod', slipModePixelMethod);
            displayMessage(`Slip Mode Pixel Method set to: ${e.target.options[e.target.selectedIndex].text}`, 'success');
        };
        settingsModal.appendChild(slipModePixelMethodSelect);

        const forceUploadBtn = createStyledButton(`Force Upload: ${useForceCanvasUpload ? 'On' : 'Off'}`, () => {
            useForceCanvasUpload = !useForceCanvasUpload; GM_setValue('useForceCanvasUpload', useForceCanvasUpload);
            forceUploadBtn.textContent = `Force Upload: ${useForceCanvasUpload ? 'On' : 'Off'}`;
            displayMessage(`Force Upload Mode: ${useForceCanvasUpload ? 'Enabled' : 'Disabled'}`, 'info');
        });
        settingsModal.appendChild(forceUploadBtn);

        const resizeContainer = document.createElement('div');
        Object.assign(resizeContainer.style, { display: 'flex', flexDirection: 'column', gap: '5px', margin: '5px 0 0 0' });
        const resizeToggleBtn = createStyledButton(`Resize Images: ${enableResize ? 'On' : 'Off'}`, () => {
            enableResize = !enableResize; GM_setValue('enableResize', enableResize);
            resizeToggleBtn.textContent = `Resize Images: ${enableResize ? 'On' : 'Off'}`;
            widthInput.disabled = heightInput.disabled = !enableResize;
        });
        resizeContainer.appendChild(resizeToggleBtn);
        const inputRow = document.createElement('div');
        Object.assign(inputRow.style, { display: 'flex', gap: '7px', alignItems: 'center' });
        const widthInput = document.createElement('input');
        widthInput.type = 'number'; widthInput.min = '1'; widthInput.value = resizeWidth; widthInput.placeholder = 'Width';
        Object.assign(widthInput.style, { width: '60px', padding: '6px', borderRadius: '4px', border: '1px solid #555', background: '#333', color: '#fff' });
        widthInput.disabled = !enableResize;
        widthInput.onchange = () => { let val = Math.max(1, parseInt(widthInput.value, 10) || 512); widthInput.value = val; resizeWidth = val; GM_setValue('resizeWidth', resizeWidth); };
        inputRow.appendChild(widthInput);
        const xLabel = document.createElement('span'); xLabel.textContent = '×'; xLabel.style.color = '#ccc'; inputRow.appendChild(xLabel);
        const heightInput = document.createElement('input');
        heightInput.type = 'number'; heightInput.min = '1'; heightInput.value = resizeHeight; heightInput.placeholder = 'Height';
        Object.assign(heightInput.style, { width: '60px', padding: '6px', borderRadius: '4px', border: '1px solid #555', background: '#333', color: '#fff' });
        heightInput.disabled = !enableResize;
        heightInput.onchange = () => { let val = Math.max(1, parseInt(heightInput.value, 10) || 512); heightInput.value = val; resizeHeight = val; GM_setValue('resizeHeight', resizeHeight); };
        inputRow.appendChild(heightInput);
        const pxLabel = document.createElement('span'); pxLabel.textContent = 'px'; pxLabel.style.color = '#bbb'; inputRow.appendChild(pxLabel);
        resizeContainer.appendChild(inputRow);
        const resizeDesc = document.createElement('div');
        resizeDesc.textContent = "If enabled, images will be resized before upload. Applies to Slip Mode too.";
        resizeDesc.style.fontSize = '12px'; resizeDesc.style.color = '#aaa'; resizeDesc.style.marginTop = '3px';
        resizeContainer.appendChild(resizeDesc);
        settingsModal.appendChild(resizeContainer);

        settingsModal.appendChild(createStyledButton('Show Logged Assets', () => {
            const log = loadLog(); const entries = Object.entries(log);
            const w = window.open('', '_blank');
            w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logged Assets</title>
            <style>body{font-family:Arial;padding:20px;background:#121212;color:#f0f0f0;} h1{margin-bottom:15px;color:#4af;} ul{list-style:none;padding:0;} li{margin-bottom:15px;padding:10px;background:#1e1e1e;border-radius:8px;display:flex;flex-direction:column;gap:8px;} img{max-height:60px;border:1px solid #444;border-radius:4px;object-fit:contain;background:#333;} .asset-info{display:flex;align-items:center;gap:15px;} a{color:#7cf;text-decoration:none;font-weight:bold;} a:hover{text-decoration:underline;} .asset-name{font-size:0.9em;color:#bbb;margin-left:auto;text-align:right;} button{margin-bottom:20px;color:#fff;background:#3a3a3a;border:1px solid #555;padding:8px 15px;border-radius:5px;cursor:pointer;} button:hover{background:#505050;}</style></head><body>
            <button onclick="document.body.style.background=(document.body.style.background==='#121212'?'#f0f0f0':'#121212');document.body.style.color=(document.body.style.color==='#f0f0f0'?'#121212':'#f0f0f0');">Toggle Theme</button>
            <h1>Logged Assets</h1>
            ${ entries.length ? `<ul>${entries.map(([id,entry])=>` <li><div class="asset-info">${ entry.image ? `<img src="${entry.image}" alt="Asset thumbnail">` : `<span style="color:#888;">(no image)</span>` }<a href="https://create.roblox.com/store/asset/${id}" target="_blank">${id}</a><span style="font-size:0.85em; color:#999;">${new Date(entry.date).toLocaleString()}</span></div><div class="asset-name">${entry.name}</div></li`).join('')}</ul>` : `<p style="color:#888;"><em>No assets logged yet.</em></p>`}
            </body></html>`);
            w.document.close();
        }));
        document.body.appendChild(settingsModal);
    }

    async function handlePastedBlob(blob, originalType) {
        const randomID = getRandomString();
        const pastedName = await customPrompt('Enter a name for the image (no extension):', `${randomID}`);
        if (pastedName === null) return;
        let name = pastedName.trim() || `${randomID}`;
        let filename = name.endsWith('.png') ? name : `${name}.png`;
        let fileToProcess = new File([blob], filename, {type: originalType || blob.type});
        const typeChoice = await customPrompt('Upload as T=T-Shirt, D=Decal, B=Both, or C=Cancel?', 'D');
        if (!typeChoice) return;
        const t = typeChoice.trim().toUpperCase();
        let uploadAsBoth = false, type = null;
        if (t === 'T') type = ASSET_TYPE_TSHIRT;
        else if (t === 'D') type = ASSET_TYPE_DECAL;
        else if (t === 'B') uploadAsBoth = true;
        else if (t === 'C') return;
        else { displayMessage('Invalid asset type selected. Please choose T, D, or B.', 'error'); return; }
        handleFileSelect([fileToProcess], type, uploadAsBoth);
    }

    async function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const it of items) {
            if (it.type.startsWith('image')) {
                e.preventDefault();
                await handlePastedBlob(it.getAsFile(), it.type);
                break;
            } else if (it.type === 'text/plain') {
                const text = await new Promise(resolve => it.getAsString(resolve));
                const trimmedText = text.trim();
                if ((trimmedText.startsWith('data:image/') || trimmedText.startsWith('data:image.')) && trimmedText.includes(';base64,')) {
                    e.preventDefault();
                    try {
                        let urlToFetch = trimmedText;
                        if (trimmedText.startsWith('data:image.')) urlToFetch = 'data:image/' + trimmedText.substring(11);
                        const res = await fetch(urlToFetch);
                        await handlePastedBlob(await res.blob(), res.headers.get('content-type') || 'image/png');
                        break;
                    } catch (err) { console.error("[Paste] Failed to convert data URL to blob:", err); }
                } else if (/^[a-zA-Z0-9+/=]+$/.test(trimmedText) && trimmedText.length > 50) {
                    try {
                        const binary = atob(trimmedText);
                        const array = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
                        e.preventDefault();
                        await handlePastedBlob(new Blob([array], { type: 'image/png' }), 'image/png');
                        break;
                    } catch (err) {}
                }
            }
        }
    }

    window.addEventListener('load', () => {
        createUI();
        document.addEventListener('paste', handlePaste);
        if (enableAssetLogging) {
            scanForAssets();
            console.log('[AnnaUploader] initialized; asset logging is ON. Scanner will run every ' + (SCAN_INTERVAL_MS/1000) + 's');
        } else {
            console.log('[AnnaUploader] initialized; asset logging is OFF.');
        }
        toggleAssetScanner(enableAssetLogging);
    });
})();
