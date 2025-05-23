// ==UserScript==
// @name         AnnaUploader (Roblox Multi-File Uploader) with Group Support
// @namespace    https://github.com/AnnaRoblox
// @version      5.9
// @description  allows you to upload multiple T-Shirts/Decals easily with AnnaUploader, now supporting groups
// @match        https://create.roblox.com/*
// @match        https://www.roblox.com/users/*/profile*
// @match        https://www.roblox.com/communities/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js
// @license      MIT
// @downloadURL  https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const ROBLOX_UPLOAD_URL  = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT  = 11;
    const ASSET_TYPE_DECAL   = 13;
    const FORCED_NAME        = "Uploaded Using AnnaUploader";

    const STORAGE_KEY = 'annaUploaderAssetLog';
    const SCAN_INTERVAL_MS = 10_000;

    let USER_ID   = GM_getValue('userId', null);
    let IS_GROUP  = GM_getValue('isGroup', false);
    let useForcedName = false;
    let useMakeUnique = false;
    let uniqueCopies = 1;
    let useDownload = false;

    let massMode = false;
    let massQueue = [];
    let batchTotal = 0;
    let completed = 0;

    let csrfToken = null;
    let statusEl, toggleBtn, startBtn, copiesInput, downloadBtn;

    // Utility: extract base name without extension
    function baseName(filename) {
        return filename.replace(/\.[^/.]+$/, '');
    }

    function loadLog() {
        const raw = GM_getValue(STORAGE_KEY, '{}');
        try { return JSON.parse(raw); }
        catch { return {}; }
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
        console.log(`[AssetLogger] logged asset ${id} at ${log[id].date}, name: ${log[id].name}, image: ${log[id].image || "none"}`);
    }

    function scanForAssets() {
        console.log('[AssetLogger] scanning for assets…');
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
    setInterval(scanForAssets, SCAN_INTERVAL_MS);

    async function fetchCSRFToken() {
        const resp = await fetch(ROBLOX_UPLOAD_URL, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (resp.status === 403) {
            const tok = resp.headers.get('x-csrf-token');
            if (tok) { csrfToken = tok; console.log('[CSRF] token fetched'); return tok; }
        }
        throw new Error('Cannot fetch CSRF token');
    }

    function updateStatus() {
        if (!statusEl) return;
        if (batchTotal > 0) {
            statusEl.textContent = `${completed} of ${batchTotal} processed`;
        } else {
            statusEl.textContent = massMode ? `${massQueue.length} queued` : '';
        }
    }

    async function uploadFile(file, assetType, retries = 0, forceName = false) {
        if (!csrfToken) await fetchCSRFToken();
        const displayName = forceName ? FORCED_NAME : baseName(file.name);
        const creator = IS_GROUP
            ? { groupId: USER_ID }
            : { userId: USER_ID };

        const fd = new FormData();
        fd.append('fileContent', file, file.name);
        fd.append('request', JSON.stringify({
            displayName,
            description: FORCED_NAME,
            assetType: assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal",
            creationContext: { creator, expectedPrice: 0 }
        }));
        try {
            const resp = await fetch(ROBLOX_UPLOAD_URL, {
                method: 'POST', credentials: 'include',
                headers: { 'x-csrf-token': csrfToken },
                body: fd
            });
            const txt = await resp.text();
            let json; try { json = JSON.parse(txt); } catch {}
            if (resp.ok && json.assetId) {
                logAsset(json.assetId, null, displayName);
                completed++;
                updateStatus();
                return;
            }
            if (json?.message === 'Asset name length is invalid.' && !forceName && retries < 5) {
                console.warn('[Upload] name too long, retrying with default name');
                return uploadFile(file, assetType, retries + 1, true);
            }
            if (resp.status === 400 && json?.message?.includes('moderated') && retries < 5) {
                return uploadFile(file, assetType, retries + 1, true);
            }
            if (resp.status === 403 && retries < 5) {
                csrfToken = null;
                return uploadFile(file, assetType, retries + 1, forceName);
            }
            console.error(`[Upload] failed ${file.name} [${resp.status}]`, txt);
        } catch (e) {
            console.error('[Upload] error', e);
        } finally {
            if (completed < batchTotal) {
                completed++;
                updateStatus();
            }
        }
    }

    // Slip Mode: subtly randomize ALL non-transparent pixels by ±1 per channel
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
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] !== 0) {
                        const delta = Math.random() < 0.5 ? -1 : 1;
                        data[i]   = Math.min(255, Math.max(0, data[i]   + delta));
                        data[i+1] = Math.min(255, Math.max(0, data[i+1] + delta));
                        data[i+2] = Math.min(255, Math.max(0, data[i+2] + delta));
                    }
                }
                ctx.putImageData(imageData, 0, 0);
                canvas.toBlob(blob => {
                    const ext = file.name.split('.').pop();
                    const newName = `${origBase}_${copyIndex}.${ext}`;
                    resolve(new File([blob], newName, { type: file.type }));
                }, file.type);
            };
            img.src = URL.createObjectURL(file);
        });
    }

    async function handleFileSelect(files, assetType, both = false) {
        if (!files?.length) return;

        const downloadsMap = {};
        const copies = useMakeUnique ? uniqueCopies : 1;
        batchTotal = files.length * (both ? 2 : 1) * copies;
        completed = 0;
        updateStatus();

        const tasks = [];

        for (const original of files) {
            const origBase = baseName(original.name);
            downloadsMap[origBase] = [];

            for (let i = 1; i <= copies; i++) {
                const filePromise = useMakeUnique
                    ? makeUniqueFile(original, origBase, i)
                    : Promise.resolve(original);

                const fileTask = filePromise.then(toUse => {
                    if (useMakeUnique && useDownload) downloadsMap[origBase].push(toUse);
                    if (both) {
                        tasks.push(uploadFile(toUse, ASSET_TYPE_TSHIRT, 0, useForcedName));
                        tasks.push(uploadFile(toUse, ASSET_TYPE_DECAL,   0, useForcedName));
                    } else {
                        tasks.push(uploadFile(toUse, assetType, 0, useForcedName));
                    }
                });

                await fileTask;
            }
        }

        Promise.all(tasks).then(() => {
            console.log('[Uploader] batch done');
            scanForAssets();
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
        });
    }

    function startMassUpload() {
        if (!massQueue.length) return alert('Nothing queued!');
        batchTotal = massQueue.length;
        completed = 0;
        updateStatus();

        const tasks = massQueue.map(item => uploadFile(item.f, item.type, 0, useForcedName));
        massQueue = [];

        Promise.all(tasks).then(() => {
            alert('Mass upload complete!');
            massMode = false;
            toggleBtn.textContent = 'Enable Mass Upload';
            startBtn.style.display = 'none';
            scanForAssets();
        });
    }

    function createUI() {
        const c = document.createElement('div');
        Object.assign(c.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            width: '260px',
            background: '#000',
            border: '2px solid #000',
            color: '#fff',
            padding: '15px',
            zIndex: 10000,
            borderRadius: '8px',
            boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontFamily: 'Arial'
        });

        function btn(text, fn) {
            const b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, {
                padding: '8px',
                cursor: 'pointer',
                color: '#fff',
                background: '#000',
                border: '1px solid #555',
                borderRadius: '4px'
            });
            b.onclick = fn;
            return b;
        }

        const close = btn('×', () => c.remove());
        Object.assign(close.style, {
            position: 'absolute',
            top: '5px',
            right: '8px',
            background: 'transparent',
            border: 'none',
            fontSize: '16px'
        });
        close.title = 'Close';
        c.appendChild(close);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader';
        title.style.margin = '0 0 5px 0';
        title.style.color = '#fff';
        c.appendChild(title);

        c.appendChild(btn('Upload T-Shirts', () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT);
            i.click();
        }));
        c.appendChild(btn('Upload Decals', () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL);
            i.click();
        }));
        c.appendChild(btn('Upload Both', () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
            i.onchange = e => handleFileSelect(e.target.files, null, true);
            i.click();
        }));

        toggleBtn = btn('Enable Mass Upload', () => {
            massMode = !massMode;
            toggleBtn.textContent = massMode ? 'Disable Mass Upload' : 'Enable Mass Upload';
            startBtn.style.display = massMode ? 'block' : 'none';
            massQueue = []; batchTotal = completed = 0; updateStatus();
        });
        c.appendChild(toggleBtn);

        startBtn = btn('Start Mass Upload', startMassUpload);
        startBtn.style.display = 'none';
        c.appendChild(startBtn);

        const nameBtn = btn('Use default Name: Off', () => {
            useForcedName = !useForcedName;
            nameBtn.textContent = `Use default Name: ${useForcedName ? 'On' : 'Off'}`;
        });
        c.appendChild(nameBtn);

        const slipBtn = btn('Slip Mode: Off', () => {
            useMakeUnique = !useMakeUnique;
            slipBtn.textContent = `Slip Mode: ${useMakeUnique ? 'On' : 'Off'}`;
            copiesInput.style.display = useMakeUnique ? 'block' : 'none';
            downloadBtn.style.display = useMakeUnique ? 'block' : 'none';
            if (!useMakeUnique) {
                useDownload = false;
                downloadBtn.textContent = 'Download Images: Off';
            }
        });
        c.appendChild(slipBtn);

        copiesInput = document.createElement('input');
        copiesInput.type = 'number'; copiesInput.min = '1'; copiesInput.value = uniqueCopies;
        copiesInput.style.width = '100%'; copiesInput.style.boxSizing = 'border-box';
        copiesInput.style.display = 'none';
        copiesInput.onchange = e => {
            const v = parseInt(e.target.value, 10);
            if (v > 0) uniqueCopies = v;
            else e.target.value = uniqueCopies;
        };
        c.appendChild(copiesInput);

        downloadBtn = btn('Download Images: Off', () => {
            useDownload = !useDownload;
            downloadBtn.textContent = `Download Images: ${useDownload ? 'On' : 'Off'}`;
        });
        downloadBtn.style.display = 'none';
        c.appendChild(downloadBtn);

        // Change ID button
        c.appendChild(btn('Change ID', () => {
            const inp = prompt("Enter your Roblox User ID/URL or Group URL:", USER_ID || '');
            if (!inp) return;
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
                if (isNaN(id)) return alert('Invalid input.');
            }
            USER_ID = Number(id);
            IS_GROUP = isGrp;
            GM_setValue('userId', USER_ID);
            GM_setValue('isGroup', IS_GROUP);
            alert(`Set to ${isGrp ? 'Group' : 'User'} ID: ${USER_ID}`);
        }));

        // "Use This Profile as ID"
        const pm = window.location.pathname.match(/^\/users\/(\d+)\/profile/);
        if (pm) {
            c.appendChild(btn('Use This Profile as ID', () => {
                USER_ID = Number(pm[1]);
                IS_GROUP = false;
                GM_setValue('userId', USER_ID);
                GM_setValue('isGroup', IS_GROUP);
                alert(`User ID set to ${USER_ID}`);
            }));
        }

        // "Use This Group as ID"
        const gm = window.location.pathname.match(/^\/communities\/(\d+)/);
        if (gm) {
            c.appendChild(btn('Use This Group as ID', () => {
                USER_ID = Number(gm[1]);
                IS_GROUP = true;
                GM_setValue('userId', USER_ID);
                GM_setValue('isGroup', IS_GROUP);
                alert(`Group ID set to ${USER_ID}`);
            }));
        }

        c.appendChild(btn('Show Logged Assets', () => {
            const log = loadLog();
            const entries = Object.entries(log);
            const w = window.open('', '_blank');
            w.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Logged Assets</title>
<style>
body { font-family:Arial; padding:20px; background:#000; color:#fff; transition:background 0.3s, color 0.3s; }
h1 { margin-bottom:10px; }
ul { padding-left:20px; }
li { margin-bottom:10px; }
img { max-height:40px; border:1px solid #fff; }
.asset-name { font-size:90%; color:#ccc; margin-left:20px; }
button { margin-bottom:10px; color:#fff; background:#222; border:1px solid #555; padding:5px 10px; border-radius:4px; }
</style></head><body>
<button onclick="document.body.style.background=(document.body.style.background==='black'?'white':'black');document.body.style.color=(document.body.style.color==='white'?'black':'white');document.querySelectorAll('img').forEach(i=>i.style.border=(document.body.style.background==='black'?'1px solid #fff':'1px solid #ccc'));">Toggle Background</button>
<h1>Logged Assets</h1>
${ entries.length ? `<ul>${entries.map(([id,entry])=>
  `<li>
    <div style="display:flex;align-items:center;gap:10px;">
      ${ entry.image ? `<img src="${entry.image}" alt>`  : `<span>(no image)</span>` }
      <a href="https://create.roblox.com/store/asset/${id}" target="_blank" style="color:#4af;">${id}</a> — ${entry.date}
    </div>
    <div class="asset-name">${entry.name}</div>
  </li>`).join('') }</ul>` : `<p><em>No assets logged yet.</em></p>`}
</body></html>`);
            w.document.close();
        }));

        const hint = document.createElement('div');
        hint.textContent = 'Paste images (Ctrl+V) to queue/upload';
        hint.style.fontSize = '12px'; hint.style.color = '#aaa';
        c.appendChild(hint);

        statusEl = document.createElement('div');
        statusEl.style.fontSize = '12px'; statusEl.style.color = '#fff';
        c.appendChild(statusEl);

        document.body.appendChild(c);
    }

    function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const it of items) {
            if (it.type.startsWith('image')) {
                e.preventDefault();
                const blob = it.getAsFile();
                const ts = new Date().toISOString().replace(/[^a-z0-9]/gi,'_');
                let name = prompt('Name (no ext):', `pasted_${ts}`);
                if (name===null) return;
                name = name.trim()||`pasted_${ts}`;
                const filename = name.endsWith('.png')? name : `${name}.png`;
                let t = prompt('T=T-Shirt, D=Decal, C=Cancel','D');
                if (!t) return;
                t = t.trim().toUpperCase();
                const type = t==='T'? ASSET_TYPE_TSHIRT : t==='D'? ASSET_TYPE_DECAL : null;
                if (!type) return;
                handleFileSelect([new File([blob], filename, {type: blob.type})], type);
                break;
            }
        }
    }

    window.addEventListener('load', () => {
        createUI();
        document.addEventListener('paste', handlePaste);
        scanForAssets();
        console.log('[AnnaUploader] initialized; asset scan every ' + (SCAN_INTERVAL_MS/1000) + 's');
    });

})();
