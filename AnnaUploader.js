// ==UserScript==
// @name         AnnaUploader (Roblox Multi-File Uploader)
// @namespace    https://www.guilded.gg/u/AnnaBlox
// @version      4.7
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
    let USER_ID     = GM_getValue('userId', null);

    // Mass-upload state
    let massMode     = false;
    let massQueue    = [];

    let csrfToken    = null;
    let batchTotal   = 0;
    let completed    = 0;
    let statusEl     = null;
    let toggleBtn    = null;
    let startBtn     = null;

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
            let json; try { json = JSON.parse(txt); } catch{}
            const badName = resp.status===400 && json?.message?.includes('moderated');
            if (badName && retries < MAX_RETRIES && !forceName) {
                await new Promise(r=>setTimeout(r, UPLOAD_RETRY_DELAY));
                return uploadFile(file, assetType, retries+1, true);
            }
            if (resp.status===403 && retries<MAX_RETRIES) {
                csrfToken = null;
                await new Promise(r=>setTimeout(r, UPLOAD_RETRY_DELAY));
                return uploadFile(file, assetType, retries+1, forceName);
            }

            console.error(`❌ ${file.name}: [${resp.status}]`, txt);
        } catch(e) {
            console.error('Upload error', e);
        } finally {
            // even on error, count as “done” so status moves
            if (!resp?.ok) {
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
            statusEl.textContent = massMode
                ? `${massQueue.length} items queued`
                : '';
        }
    }

    function handleFileSelect(files, assetType, both=false) {
        if (!files || files.length===0) return;
        if (massMode) {
            for (let f of files) {
                if (both) {
                    massQueue.push({f,type:ASSET_TYPE_TSHIRT});
                    massQueue.push({f,type:ASSET_TYPE_DECAL});
                } else {
                    massQueue.push({f,type:assetType});
                }
            }
            updateStatus();
            return;
        }

        // immediate parallel upload
        const tasks = [];
        batchTotal = both ? files.length*2 : files.length;
        completed = 0;
        updateStatus();
        for (let f of files) {
            if (both) {
                tasks.push(uploadFile(f, ASSET_TYPE_TSHIRT));
                tasks.push(uploadFile(f, ASSET_TYPE_DECAL));
            } else {
                tasks.push(uploadFile(f, assetType));
            }
        }
        Promise.all(tasks).then(()=>console.log('[Uploader] done'));
    }

    function startMassUpload() {
        if (massQueue.length===0) return alert('Nothing queued!');
        batchTotal = massQueue.length;
        completed = 0;
        updateStatus();

        const tasks = massQueue.map(item => uploadFile(item.f, item.type));
        massQueue = [];
        updateStatus();
        Promise.all(tasks).then(()=>{
            alert('Mass upload complete!');
            toggleBtn.textContent = 'Enable Mass Upload';
            massMode = false;
            startBtn.style.display = 'none';
        });
    }

    function createUploaderUI() {
        const c = document.createElement('div');
        Object.assign(c.style, {
            position:'fixed', top:'10px', right:'10px',
            background:'#fff', border:'2px solid #000', padding:'15px',
            zIndex:'10000', borderRadius:'8px', boxShadow:'0 4px 8px rgba(0,0,0,0.2)',
            display:'flex', flexDirection:'column', gap:'8px', fontFamily:'Arial', width:'240px'
        });

        // Close
        const close = document.createElement('button');
        close.textContent='×';
        Object.assign(close.style,{
            position:'absolute',top:'5px',right:'8px',
            background:'transparent',border:'none',fontSize:'16px',cursor:'pointer'
        });
        close.title='Close';
        close.onclick = ()=>c.remove();
        c.appendChild(close);

        // Title
        const title = document.createElement('h3');
        title.textContent='AnnaUploader';
        title.style.margin='0 0 5px 0';
        title.style.fontSize='16px';
        c.appendChild(title);

        // Buttons factory
        const makeBtn = (txt,fn)=>{
            const b=document.createElement('button');
            b.textContent=txt;
            Object.assign(b.style,{padding:'8px',cursor:'pointer'});
            b.onclick=fn;
            return b;
        };

        // Upload controls
        c.appendChild(makeBtn('Upload T-Shirts',()=>{
            const inp=document.createElement('input');
            inp.type='file'; inp.accept='image/*'; inp.multiple=true;
            inp.onchange = e=> handleFileSelect(e.target.files, ASSET_TYPE_TSHIRT);
            inp.click();
        }));
        c.appendChild(makeBtn('Upload Decals',()=>{
            const inp=document.createElement('input');
            inp.type='file'; inp.accept='image/*'; inp.multiple=true;
            inp.onchange = e=> handleFileSelect(e.target.files, ASSET_TYPE_DECAL);
            inp.click();
        }));
        c.appendChild(makeBtn('Upload Both',()=>{
            const inp=document.createElement('input');
            inp.type='file'; inp.accept='image/*'; inp.multiple=true;
            inp.onchange = e=> handleFileSelect(e.target.files, null, true);
            inp.click();
        }));

        // Mass-upload toggle
        toggleBtn = makeBtn('Enable Mass Upload', ()=>{
            massMode = !massMode;
            toggleBtn.textContent = massMode ? 'Disable Mass Upload' : 'Enable Mass Upload';
            startBtn.style.display = massMode ? 'block' : 'none';
            massQueue = [];
            batchTotal = 0; completed = 0;
            updateStatus();
        });
        c.appendChild(toggleBtn);

        // Start button (hidden until massMode)
        startBtn = makeBtn('Start Mass Upload', startMassUpload);
        startBtn.style.display = 'none';
        c.appendChild(startBtn);

        // Change ID
        c.appendChild(makeBtn('Change ID', ()=>{
            const inp=prompt("Enter your Roblox User ID or Profile URL:", USER_ID||'');
            if (!inp) return;
            const m=inp.match(/users\/(\d+)/);
            const id = m ? m[1] : inp.trim();
            if (!isNaN(id)) {
                USER_ID = Number(id);
                GM_setValue('userId', USER_ID);
                alert(`User ID set to ${USER_ID}`);
            } else alert('Invalid input.');
        }));

        // Profile shortcut
        const pm = window.location.pathname.match(/^\/users\/(\d+)\/profile/);
        if (pm) {
            c.appendChild(makeBtn('Use This Profile as ID', ()=>{
                USER_ID = Number(pm[1]);
                GM_setValue('userId', USER_ID);
                alert(`User ID set to ${USER_ID}`);
            }));
        }

        // Paste hint & status
        const hint = document.createElement('div');
        hint.textContent='Paste images (Ctrl+V) to queue/upload';
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
        for (let it of items) {
            if (it.type.startsWith('image')) {
                e.preventDefault();
                const blob = it.getAsFile();
                const ts = new Date().toISOString().replace(/[^a-z0-9]/gi,'_');
                let name = prompt('Name (no ext):', `pasted_${ts}`);
                if (name===null) return;
                name = name.trim()||`pasted_${ts}`;
                const filename = name.endsWith('.png')?name:`${name}.png`;
                let t = prompt('T=T-Shirt, D=Decal, C=Cancel','D');
                if (!t) return;
                t = t.trim().toUpperCase();
                let type = null;
                if (t==='T') type = ASSET_TYPE_TSHIRT;
                else if (t==='D') type = ASSET_TYPE_DECAL;
                else return;
                const file = new File([blob], filename, {type:blob.type});
                handleFileSelect([file], type);
                break;
            }
        }
    }

    window.addEventListener('load', ()=>{
        createUploaderUI();
        document.addEventListener('paste', handlePaste);
        console.log('[AnnaUploader] initialized, massMode=', massMode);
    });

})();
