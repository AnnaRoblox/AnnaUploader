// ==UserScript==
// @name         AnnaUploader (Roblox Multi-File Uploader)
// @namespace    https://www.guilded.gg/u/AnnaBlox
// @version      5.1
// @description  allows you to upload multiple T-Shirts/Decals easily with AnnaUploader
// @match        https://create.roblox.com/*
// @match        https://www.roblox.com/users/*/profile*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @license      MIT
// @downloadURL  https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/534460/AnnaUploader%20%28Roblox%20Multi-File%20Uploader%29.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const ROBLOX_UPLOAD_URL  = "https://apis.roblox.com/assets/user-auth/v1/assets";
    const ASSET_TYPE_TSHIRT  = 11;
    const ASSET_TYPE_DECAL   = 13;
    const UPLOAD_RETRY_DELAY = 0;
    const MAX_RETRIES        = 150;
    const FORCED_NAME        = "Uploaded Using AnnaUploader";

    // Stored settings
    let USER_ID         = GM_getValue('userId', null);
    let useForcedName   = false; // false => use file names, true => use FORCED_NAME
    let useMakeUnique   = false; // Slip Mode: tweak a random pixel for uniqueness
    let uniqueCopies    = 1;     // number of unique copies when Slip Mode is on

    // Mass-upload state
    let massMode     = false;
    let massQueue    = [];

    let csrfToken    = null;
    let batchTotal   = 0;
    let completed    = 0;
    let statusEl     = null;
    let toggleBtn    = null;
    let startBtn     = null;
    let copiesInput  = null;

    // Fetch CSRF token
    async function fetchCSRFToken() {
        const resp = await fetch(ROBLOX_UPLOAD_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({})
        });
        if (resp.status === 403) {
            const tok = resp.headers.get('x-csrf-token');
            if (tok) {
                csrfToken = tok;
                console.log('[CSRF] fetched:', tok);
                return tok;
            }
        }
        throw new Error('Cannot fetch CSRF token');
    }

    // Make a file unique by altering one random pixel
    function makeUniqueFile(file) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const x = Math.floor(Math.random() * canvas.width);
                const y = Math.floor(Math.random() * canvas.height);
                const r = Math.floor(Math.random() * 256);
                const g = Math.floor(Math.random() * 256);
                const b = Math.floor(Math.random() * 256);
                ctx.fillStyle = `rgba(${r},${g},${b},1)`;
                ctx.fillRect(x, y, 1, 1);
                canvas.toBlob(blob => {
                    const newFile = new File([blob], file.name, { type: file.type });
                    resolve(newFile);
                }, file.type);
            };
            img.src = URL.createObjectURL(file);
        });
    }

    // Core upload with retries & forced-name
    async function uploadFile(file, assetType, retries = 0, forceName = false) {
        if (!csrfToken) await fetchCSRFToken();
        const displayName = forceName ? FORCED_NAME : file.name.split('.')[0];
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
                method: 'POST',
                credentials: 'include',
                headers: { 'x-csrf-token': csrfToken },
                body: fd
            });
            if (resp.ok) {
                console.log(`✅ ${displayName}`);
                completed++;
                updateStatus();
                return;
            }
            const txt = await resp.text();
            let json;
            try { json = JSON.parse(txt); } catch {}
            const badName = resp.status === 400 && json?.message?.includes('moderated');
            if (badName && retries < MAX_RETRIES && !forceName) {
                await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY));
                return uploadFile(file, assetType, retries + 1, true);
            }
            if (resp.status === 403 && retries < MAX_RETRIES) {
                csrfToken = null;
                await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY));
                return uploadFile(file, assetType, retries + 1, forceName);
            }
            console.error(`❌ ${file.name}: [${resp.status}]`, txt);
        } catch (e) {
            console.error('Upload error', e);
        } finally {
            if (completed < batchTotal) {
                completed++;
                updateStatus();
            }
        }
    }

    // Update status text
    function updateStatus() {
        if (!statusEl) return;
        if (batchTotal > 0) {
            statusEl.textContent = `${completed} of ${batchTotal} processed`;
        } else {
            statusEl.textContent = massMode
                ? `${massQueue.length} items queued`
                : '';
        }
    }

    // Handle file select / queuing / immediate upload
    async function handleFileSelect(files, assetType, both = false) {
        if (!files || files.length === 0) return;
        const copies = useMakeUnique ? uniqueCopies : 1;

        // Mass mode: just queue
        if (massMode) {
            for (let f of files) {
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

        // Immediate: kick off uploads
        batchTotal = files.length * (both ? 2 : 1) * copies;
        completed = 0;
        updateStatus();

        const tasks = [];
        for (let f of files) {
            for (let i = 0; i < copies; i++) {
                const toUse = useMakeUnique ? await makeUniqueFile(f) : f;
                if (both) {
                    tasks.push(uploadFile(toUse, ASSET_TYPE_TSHIRT, 0, useForcedName));
                    tasks.push(uploadFile(toUse, ASSET_TYPE_DECAL, 0, useForcedName));
                } else {
                    tasks.push(uploadFile(toUse, assetType, 0, useForcedName));
                }
            }
        }
        Promise.all(tasks).then(() => console.log('[Uploader] done'));
    }

    // Start mass-upload processing
    function startMassUpload() {
        if (massQueue.length === 0) return alert('Nothing queued!');
        batchTotal = massQueue.length;
        completed = 0;
        updateStatus();

        const tasks = massQueue.map(item =>
            uploadFile(item.f, item.type, 0, useForcedName)
        );
        massQueue = [];
        updateStatus();
        Promise.all(tasks).then(() => {
            alert('Mass upload complete!');
            toggleBtn.textContent = 'Enable Mass Upload';
            massMode = false;
            startBtn.style.display = 'none';
        });
    }

    // Build the UI panel
    function createUploaderUI() {
        const c = document.createElement('div');
        Object.assign(c.style, {
            position:'fixed', top:'10px', right:'10px',
            background:'#fff', border:'2px solid #000', padding:'15px',
            zIndex:'10000', borderRadius:'8px', boxShadow:'0 4px 8px rgba(0,0,0,0.2)',
            display:'flex', flexDirection:'column', gap:'8px', fontFamily:'Arial', width:'260px'
        });

        // Close button
        const close = document.createElement('button');
        close.textContent = '×';
        Object.assign(close.style, {
            position:'absolute', top:'5px', right:'8px',
            background:'transparent', border:'none', fontSize:'16px', cursor:'pointer'
        });
        close.title = 'Close';
        close.onclick = () => c.remove();
        c.appendChild(close);

        // Title
        const title = document.createElement('h3');
        title.textContent = 'AnnaUploader';
        title.style.margin = '0 0 5px 0';
        title.style.fontSize = '16px';
        c.appendChild(title);

        // Button factory
        const makeBtn = (txt, fn) => {
            const b = document.createElement('button');
            b.textContent = txt;
            Object.assign(b.style, { padding:'8px', cursor:'pointer' });
            b.onclick = fn;
            return b;
        };

        // Upload T-Shirts
        c.appendChild(makeBtn('Upload T-Shirts', () => {
            const inp = document.createElement('input');
            inp.type='file';
            inp.accept='image/*';
            inp.multiple=true;
            inp.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT);
            inp.click();
        }));

        // Upload Decals
        c.appendChild(makeBtn('Upload Decals', () => {
            const inp = document.createElement('input');
            inp.type='file';
            inp.accept='image/*';
            inp.multiple=true;
            inp.onchange = e => handleFileSelect(e.target.files, ASSET_TYPE_DECAL);
            inp.click();
        }));

        // Upload Both
        c.appendChild(makeBtn('Upload Both', () => {
            const inp = document.createElement('input');
            inp.type='file';
            inp.accept='image/*';
            inp.multiple=true;
            inp.onchange = e => handleFileSelect(e.target.files, null, true);
            inp.click();
        }));

        // Mass-upload toggle
        toggleBtn = makeBtn('Enable Mass Upload', () => {
            massMode = !massMode;
            toggleBtn.textContent = massMode ? 'Disable Mass Upload' : 'Enable Mass Upload';
            startBtn.style.display = massMode ? 'block' : 'none';
            massQueue = [];
            batchTotal = 0;
            completed = 0;
            updateStatus();
        });
        c.appendChild(toggleBtn);

        // Start mass-upload
        startBtn = makeBtn('Start Mass Upload', startMassUpload);
        startBtn.style.display = 'none';
        c.appendChild(startBtn);

        // Forced-name toggle
        const nameToggleBtn = makeBtn(`Use default Name: Off`, () => {
            useForcedName = !useForcedName;
            nameToggleBtn.textContent = `Use default Name: ${useForcedName ? 'On' : 'Off'}`;
        });
        c.appendChild(nameToggleBtn);

        // Slip Mode toggle
        const uniqueToggleBtn = makeBtn(`Slip Mode: Off`, () => {
            useMakeUnique = !useMakeUnique;
            uniqueToggleBtn.textContent = `Slip Mode: ${useMakeUnique ? 'On' : 'Off'}`;
            copiesInput.style.display = useMakeUnique ? 'block' : 'none';
        });
        c.appendChild(uniqueToggleBtn);

        // Copies input
        copiesInput = document.createElement('input');
        copiesInput.type = 'number';
        copiesInput.min = '1';
        copiesInput.value = uniqueCopies;
        copiesInput.title = 'Number of unique copies';
        copiesInput.style.width = '100%';
        copiesInput.style.boxSizing = 'border-box';
        copiesInput.style.display = 'none';
        copiesInput.onchange = e => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) uniqueCopies = v;
            else e.target.value = uniqueCopies;
        };
        c.appendChild(copiesInput);

        // Change user ID
        c.appendChild(makeBtn('Change ID', () => {
            const inp = prompt("Enter your Roblox User ID or Profile URL:", USER_ID || '');
            if (!inp) return;
            const m = inp.match(/users\/(\d+)/);
            const id = m ? m[1] : inp.trim();
            if (!isNaN(id)) {
                USER_ID = Number(id);
                GM_setValue('userId', USER_ID);
                alert(`User ID set to ${USER_ID}`);
            } else alert('Invalid input.');
        }));

        // Use profile shortcut
        const pm = window.location.pathname.match(/^\/users\/(\d+)\/profile/);
        if (pm) {
            c.appendChild(makeBtn('Use This Profile as ID', () => {
                USER_ID = Number(pm[1]);
                GM_setValue('userId', USER_ID);
                alert(`User ID set to ${USER_ID}`);
            }));
        }

        // Hint & status
        const hint = document.createElement('div');
        hint.textContent = 'Paste images (Ctrl+V) to queue/upload';
        hint.style.fontSize = '12px';
        hint.style.color = '#555';
        c.appendChild(hint);

        statusEl = document.createElement('div');
        statusEl.style.fontSize = '12px';
        statusEl.style.color = '#000';
        c.appendChild(statusEl);

        document.body.appendChild(c);
    }

    // Handle paste
    function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let it of items) {
            if (it.type.startsWith('image')) {
                e.preventDefault();
                const blob = it.getAsFile();
                const ts = new Date().toISOString().replace(/[^a-z0-9]/gi,'_');
                let name = prompt('Name (no ext):', `pasted_${ts}`);
                if (name === null) return;
                name = name.trim() || `pasted_${ts}`;
                const filename = name.endsWith('.png') ? name : `${name}.png`;
                let t = prompt('T=T-Shirt, D=Decal, C=Cancel','D');
                if (!t) return;
                t = t.trim().toUpperCase();
                let type = null;
                if (t === 'T') type = ASSET_TYPE_TSHIRT;
                else if (t === 'D') type = ASSET_TYPE_DECAL;
                else return;
                const file = new File([blob], filename, {type: blob.type});
                handleFileSelect([file], type);
                break;
            }
        }
    }

    // Init
    window.addEventListener('load', () => {
        createUploaderUI();
        document.addEventListener('paste', handlePaste);
        console.log('[AnnaUploader] initialized, massMode=', massMode,
                    'useForcedName=', useForcedName,
                    'useMakeUnique=', useMakeUnique,
                    'uniqueCopies=', uniqueCopies);
    });

})();
