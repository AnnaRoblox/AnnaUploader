// ==UserScript==
// @name         AnnaUploader (Roblox Multi-File Uploader)
// @namespace    https://www.guilded.gg/u/AnnaBlox
// @version      5.2
// @description  allows you to upload multiple T-Shirts/Decals easily with AnnaUploader
// @match        https://create.roblox.com/*
// @match        https://www.roblox.com/users/*/profile*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @downloadURL  https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const ROBLOX_UPLOAD_URL  = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT  = 11;
    const ASSET_TYPE_DECAL   = 13;
    const FORCED_NAME        = "Uploaded Using AnnaUploader";

    const STORAGE_KEY = 'annaUploaderAssetLog';
    const SCAN_INTERVAL_MS = 10_000;

    let USER_ID = GM_getValue('userId', null);
    let useForcedName = false;
    let useMakeUnique = false;
    let uniqueCopies = 1;

    let massMode = false;
    let massQueue = [];
    let batchTotal = 0;
    let completed = 0;

    let csrfToken = null;
    let statusEl, toggleBtn, startBtn, copiesInput;

    function loadLog() {
        const raw = GM_getValue(STORAGE_KEY, '{}');
        try { return JSON.parse(raw); }
        catch { return {}; }
    }

    function saveLog(log) {
        GM_setValue(STORAGE_KEY, JSON.stringify(log));
    }

    function logAsset(id, imageURL) {
        const log = loadLog();
        log[id] = {
            date: new Date().toISOString(),
            image: imageURL || log[id]?.image || null
        };
        saveLog(log);
        console.log(`[AssetLogger] logged asset ${id} at ${log[id].date}, image: ${log[id].image || "none"}`);
    }

    function scanForAssets() {
        console.log('[AssetLogger] scanning for assets…');
        const log = loadLog();
        document.querySelectorAll('[href]').forEach(el => {
            const href = el.href;
            let m = href.match(/(?:https?:\/\/create\.roblox\.com)?\/store\/asset\/(\d+)/);
            if (!m) m = href.match(/\/dashboard\/creations\/store\/(\d+)\/configure/);
            if (m) {
                const id = m[1];
                let image = null;

                const container = el.closest('*'); // search container around the link
                const img = container.querySelector('img');
                if (img && img.src) {
                    image = img.src;
                }

                logAsset(id, image);
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

    function makeUniqueFile(file) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const x = Math.floor(Math.random()*canvas.width);
                const y = Math.floor(Math.random()*canvas.height);
                ctx.fillStyle = `rgba(${Math.random()*255|0},${Math.random()*255|0},${Math.random()*255|0},1)`;
                ctx.fillRect(x, y, 1, 1);
                canvas.toBlob(blob => resolve(new File([blob], file.name, {type:file.type})), file.type);
            };
            img.src = URL.createObjectURL(file);
        });
    }

    async function uploadFile(file, assetType, retries = 0, forceName = false) {
        if (!csrfToken) await fetchCSRFToken();
        const displayName = forceName ? FORCED_NAME : file.name.replace(/\.[^/.]+$/, '');
        const fd = new FormData();
        fd.append('fileContent', file, file.name);
        fd.append('request', JSON.stringify({
            displayName,
            description: FORCED_NAME,
            assetType: assetType === ASSET_TYPE_TSHIRT ? "TShirt" : "Decal",
            creationContext: { creator: { userId: USER_ID }, expectedPrice: 0 }
        }));
        try {
            const resp = await fetch(ROBLOX_UPLOAD_URL, {
                method: 'POST', credentials: 'include',
                headers: { 'x-csrf-token': csrfToken },
                body: fd
            });
            if (resp.ok) {
                const result = await resp.json();
                if (result.assetId) logAsset(result.assetId, null);
                completed++;
                updateStatus();
                return;
            }
            const txt = await resp.text();
            let json; try { json = JSON.parse(txt); } catch {}
            if (resp.status === 400 && json?.message?.includes('moderated') && retries < 5) {
                return uploadFile(file, assetType, retries+1, true);
            }
            if (resp.status === 403 && retries < 5) {
                csrfToken = null;
                return uploadFile(file, assetType, retries+1, forceName);
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

    function updateStatus() {
        if (!statusEl) return;
        if (batchTotal > 0) {
            statusEl.textContent = `${completed} of ${batchTotal} processed`;
        } else {
            statusEl.textContent = massMode ? `${massQueue.length} queued` : '';
        }
    }

    async function handleFileSelect(files, assetType, both = false) {
        if (!files?.length) return;
        const copies = useMakeUnique ? uniqueCopies : 1;
        if (massMode) {
            for (const f of files) {
                for (let i = 0; i < copies; i++) {
                    const toUse = useMakeUnique ? await makeUniqueFile(f) : f;
                    if (both) {
                        massQueue.push({ f: toUse, type: ASSET_TYPE_TSHIRT });
                        massQueue.push({ f: toUse, type: ASSET_TYPE_DECAL });
                    } else {
                        massQueue.push({ f: toUse, type: assetType });
                    }
                }
            }
            updateStatus();
            return;
        }
        batchTotal = files.length * (both ? 2 : 1) * copies;
        completed = 0;
        updateStatus();
        const tasks = [];
        for (const f of files) {
            for (let i = 0; i < copies; i++) {
                const toUse = useMakeUnique ? await makeUniqueFile(f) : f;
                if (both) {
                    tasks.push(uploadFile(toUse, ASSET_TYPE_TSHIRT, 0, useForcedName));
                    tasks.push(uploadFile(toUse, ASSET_TYPE_DECAL,   0, useForcedName));
                } else {
                    tasks.push(uploadFile(toUse, assetType, 0, useForcedName));
                }
            }
        }
        Promise.all(tasks).then(() => {
            console.log('[Uploader] batch done');
            scanForAssets();
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
            position:'fixed', top:'10px', right:'10px', width:'260px',
            background:'#fff', border:'2px solid #000', padding:'15px',
            zIndex:10000, borderRadius:'8px', boxShadow:'0 4px 8px rgba(0,0,0,0.2)',
            display:'flex', flexDirection:'column', gap:'8px', fontFamily:'Arial'
        });

        function btn(text, fn) {
            const b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, { padding:'8px', cursor:'pointer' });
            b.onclick = fn;
            return b;
        }

        const close = btn('×', () => c.remove());
        Object.assign(close.style, {
            position:'absolute', top:'5px', right:'8px',
            background:'transparent', border:'none', fontSize:'16px'
        });
        close.title = 'Close';
        c.appendChild(close);

        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader';
        title.style.margin = '0 0 5px 0';
        c.appendChild(title);

        c.appendChild(btn('Upload T-Shirts', () => {
            const i = document.createElement('input');
            i.type='file'; i.accept='image/*'; i.multiple=true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT);
            i.click();
        }));
        c.appendChild(btn('Upload Decals', () => {
            const i = document.createElement('input');
            i.type='file'; i.accept='image/*'; i.multiple=true;
            i.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL);
            i.click();
        }));
        c.appendChild(btn('Upload Both', () => {
            const i = document.createElement('input');
            i.type='file'; i.accept='image/*'; i.multiple=true;
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
            nameBtn.textContent = `Use default Name: ${useForcedName?'On':'Off'}`;
        });
        c.appendChild(nameBtn);

        const slipBtn = btn('Slip Mode: Off', () => {
            useMakeUnique = !useMakeUnique;
            slipBtn.textContent = `Slip Mode: ${useMakeUnique?'On':'Off'}`;
            copiesInput.style.display = useMakeUnique ? 'block' : 'none';
        });
        c.appendChild(slipBtn);
        copiesInput = document.createElement('input');
        copiesInput.type='number'; copiesInput.min='1'; copiesInput.value=uniqueCopies;
        copiesInput.style.width='100%'; copiesInput.style.boxSizing='border-box';
        copiesInput.style.display='none';
        copiesInput.onchange = e => {
            const v = parseInt(e.target.value,10);
            if (v>0) uniqueCopies = v;
            else e.target.value = uniqueCopies;
        };
        c.appendChild(copiesInput);

        c.appendChild(btn('Change ID', () => {
            const inp = prompt("Enter your Roblox User ID or Profile URL:", USER_ID||'');
            if (!inp) return;
            const m = inp.match(/users\/(\d+)/);
            const id = m ? m[1] : inp.trim();
            if (!isNaN(id)) {
                USER_ID = Number(id);
                GM_setValue('userId', USER_ID);
                alert(`User ID set to ${USER_ID}`);
            } else alert('Invalid input.');
        }));

        const pm = window.location.pathname.match(/^\/users\/(\d+)\/profile/);
        if (pm) {
            c.appendChild(btn('Use This Profile as ID', () => {
                USER_ID = Number(pm[1]);
                GM_setValue('userId', USER_ID);
                alert(`User ID set to ${USER_ID}`);
            }));
        }

        c.appendChild(btn('Show Logged Assets', () => {
            const log = loadLog();
            const entries = Object.entries(log);
            const w = window.open('', '_blank');
            w.document.write(`<!DOCTYPE html>
<html><head><title>Logged Assets</title><meta charset="utf-8">
<style>
body { font-family:Arial; padding:20px; }
h1 { margin-bottom:10px; }
ul { padding-left:20px; }
li { margin-bottom:6px; display: flex; align-items: center; gap: 10px; }
img { max-height: 40px; border: 1px solid #ccc; }
</style></head><body><h1>Logged Assets</h1>
${ entries.length ? `<ul>${entries.map(([id, entry]) => {
    let label = '';
    if (entry.image) {
        label = `<img src="${entry.image}" alt="thumb">`;
    } else if (entry.image === null && entry.date) {
        label = `<span>(image removed)</span>`;
    } else {
        label = `<span>(in review/image declined)</span>`;
    }
    return `<li>${label} <a href="https://create.roblox.com/store/asset/${id}" target="_blank">${id}</a> — ${entry.date}</li>`;
}).join('')}</ul>` : `<p><em>No assets logged yet.</em></p>` }
</body></html>`);
            w.document.close();
        }));

        const hint = document.createElement('div');
        hint.textContent = 'Paste images (Ctrl+V) to queue/upload';
        hint.style.fontSize='12px'; hint.style.color='#555';
        c.appendChild(hint);

        statusEl = document.createElement('div');
        statusEl.style.fontSize='12px'; statusEl.style.color='#000';
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
                const type = t==='T'
                    ? ASSET_TYPE_TSHIRT
                    : t==='D'
                      ? ASSET_TYPE_DECAL
                      : null;
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
        console.log('[AnnaUploader]  initialized; asset scan every ' + (SCAN_INTERVAL_MS/1000) + 's');
    });

})();
