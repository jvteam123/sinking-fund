/* ============================================================
   MSF PRO — Application Logic
   Financial Management & Audit System v2.1
   ============================================================ */

'use strict';

    /*
    ============================================================
    REQUIRED: FIRESTORE SECURITY RULES
    Paste these into Firebase Console → Firestore → Rules tab
    ============================================================
    rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /system/main {
          // Only authenticated users whose email is in the ADMINS list can write
          allow write: if request.auth != null &&
            request.auth.token.email in [
              "ev.lorens.ebrado@gmail.com",
              "ev.anderson4470@gmail.com"
            ];
          // Any authenticated user can read (needed for member dashboard)
          allow read: if request.auth != null;
        }
        // Block all other collections
        match /{document=**} {
          allow read, write: if false;
        }
      }
    }
    ============================================================
    */
    const firebaseConfig = {
        apiKey: "AIzaSyC5nSdDA5IrA0Gpt_nUcpT2NI0kdGGU3wI",
        authDomain: "sinking-fund-51fcd.firebaseapp.com",
        projectId: "sinking-fund-51fcd",
        storageBucket: "sinking-fund-51fcd.firebasestorage.app",
        messagingSenderId: "943953104162",
        appId: "1:943953104162:web:872f8dbc6f3fac7c63a97b"
    };
    const ADMINS = ["ev.lorens.ebrado@gmail.com", "ev.anderson4470@gmail.com"];
    // WIPE_PIN stored as SHA-256 hash — never store plain text or base64 for sensitive pins
    const WIPE_PIN_HASH = "2f3c8e7c3e08228a27e8e9944aaf907501bfc3b806a6d3bab4a69dba74b0e1da"; // SHA-256 of wipe PIN
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();

    // ===== OFFLINE DETECTION =====
    let isOnline = navigator.onLine;
    let offlineBanner = null;
    function showOfflineBanner() {
        if (offlineBanner) return;
        offlineBanner = document.createElement('div');
        offlineBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:white;text-align:center;padding:10px;font-size:0.82rem;font-weight:700;letter-spacing:0.5px;';
        offlineBanner.innerHTML = '<i class="fas fa-wifi" style="margin-right:6px;opacity:0.7"></i> You are offline. Changes will not be saved until connection is restored.';
        document.body.prepend(offlineBanner);
    }
    function hideOfflineBanner() { if (offlineBanner) { offlineBanner.remove(); offlineBanner = null; } }
    window.addEventListener('online', () => { isOnline = true; hideOfflineBanner(); notify('Back online — data sync resumed', 'success'); });
    window.addEventListener('offline', () => { isOnline = false; showOfflineBanner(); });
    if (!navigator.onLine) showOfflineBanner();

    // ===== SESSION TIMEOUT (60 min inactivity) =====
    const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
    let sessionTimer = null;
    function resetSessionTimer() {
        clearTimeout(sessionTimer);
        sessionTimer = setTimeout(() => {
            notify('Session expired due to inactivity. Signing out...', 'error');
            setTimeout(() => auth.signOut().then(() => location.reload()), 2000);
        }, SESSION_TIMEOUT_MS);
    }
    ['click','keydown','mousemove','touchstart'].forEach(e => document.addEventListener(e, resetSessionTimer, { passive: true }));

    let appData = { settings: { contri: 100, interest: 5 }, members: [], cycles: ["Jan"], hiddenMonths: [], loans: [], profit: 0, logs: [] };
    let currentLoanPage = 1;
    const loansPerPage = 4;
    let confirmCallback = null;
    let selectedNewSlots = 1;
    let currentLoanType = 'member';
    let currentUser = null;

    // ===== INIT =====
    document.getElementById('overviewDate').innerText = new Date().toLocaleDateString('en-PH', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    function hideLoading() { document.getElementById('loadingOverlay').style.display = 'none'; }

    // ===== CONFIRM DIALOG =====
    function showConfirm(title, message, callback, type = 'danger', icon = '⚠️') {
        document.getElementById('confirmTitle').innerText = title;
        document.getElementById('confirmMessage').innerText = message;
        document.getElementById('confirmIcon').innerText = icon;
        const btn = document.getElementById('confirmOkBtn');
        btn.className = 'confirm-ok' + (type === 'success' ? ' success' : '');
        confirmCallback = callback;
        document.getElementById('confirmOverlay').classList.add('show');
    }
    function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('show'); confirmCallback = null; }
    function executeConfirm() { if (confirmCallback) confirmCallback(); closeConfirm(); }
    document.getElementById('confirmOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeConfirm(); });

    // ===== TOAST =====
    function notify(msg, type = 'success') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = 'custom-toast' + (type === 'error' ? ' error' : '');
        const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
        toast.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 50);
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
    }

    // ===== SANITIZE (prevent XSS in innerHTML renders) =====
    function sanitize(str) {
        const el = document.createElement('div');
        el.appendChild(document.createTextNode(String(str || '')));
        return el.innerHTML;
    }

    // ===== CALCULATIONS =====
    function calculateSystemCash() {
        let total = 0;
        appData.members.forEach(m => {
            total += Number(m.carryOver || 0);
            (m.payments || []).forEach(p => { if (p) total += Number(appData.settings.contri) * (m.slots || 1); });
        });
        const loanPrincipal = (appData.loans || []).reduce((acc, l) => acc + Number(l.principal), 0);
        return (total + (appData.profit || 0)) - loanPrincipal;
    }

    function getMemberContribution(m) {
        let s = Number(m.carryOver || 0);
        (m.payments || []).forEach(p => { if (p) s += Number(appData.settings.contri) * (m.slots || 1); });
        return s;
    }

    // ===== PERSISTENCE =====
    function save() {
        if (!isOnline) { notify('Offline — changes queued and will sync when reconnected', 'error'); }
        db.collection("system").doc("main").set(appData).catch(err => {
            console.error('Save failed:', err);
            notify('Save failed — check your connection', 'error');
        });
    }
    function signIn() { auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
    function signOut() { auth.signOut().then(() => location.reload()); }

    function logAction(act) {
        if (!appData.logs) appData.logs = [];
        const now = new Date();
        appData.logs.unshift({
            time: `${now.toLocaleDateString()}, ${now.toLocaleTimeString()}`,
            admin: auth.currentUser ? auth.currentUser.displayName : 'System',
            balance: `₱${calculateSystemCash().toLocaleString()}`,
            act: act
        });
        if (appData.logs.length > 100) appData.logs.pop();
    }

    // ===== AUTH =====
    auth.onAuthStateChanged(user => {
        if (user) {
            currentUser = user;
            db.collection("system").doc("main").onSnapshot(doc => {
                if (doc.exists) {
                    appData = doc.data();
                    if (!appData.hiddenMonths) appData.hiddenMonths = [];
                    if (!appData.loans) appData.loans = [];
                    if (!appData.logs) appData.logs = [];
                } else { save(); }

                const email = user.email.toLowerCase();
                const isAdmin = ADMINS.includes(email);
                const memberRecord = appData.members.find(m => m.email.toLowerCase() === email);
                const isMember = !!memberRecord;
                const isBanned = memberRecord && memberRecord.banned;

                hideLoading();

                if (!isAdmin && !isMember) {
                    notify(`Unauthorized: ${user.email} is not registered.`, 'error');
                    setTimeout(() => { auth.signOut().then(() => location.reload()); }, 2500);
                    return;
                }

                if (!isAdmin && isBanned) {
                    notify(`Access denied: Your account has been suspended. Contact your admin.`, 'error');
                    setTimeout(() => { auth.signOut().then(() => location.reload()); }, 3000);
                    return;
                }

                document.getElementById('topNav').style.display = 'flex';
                document.getElementById('loginPage').style.display = 'none';
                document.getElementById('navAvatar').innerText = user.displayName ? user.displayName[0].toUpperCase() : 'U';
                document.getElementById('navName').innerText = user.displayName || user.email;
                document.getElementById('navRole').innerText = isAdmin ? '🛡 Admin' : '👤 Member';
                resetSessionTimer(); // start inactivity timeout

                if (isAdmin) {
                    document.getElementById('adminDashboard').style.display = 'block';
                    document.getElementById('memberDashboard').style.display = 'none';
                    renderAdmin();
                } else {
                    document.getElementById('memberDashboard').style.display = 'block';
                    document.getElementById('adminDashboard').style.display = 'none';
                    renderMember(user);
                }
            });
        } else {
            hideLoading();
            document.getElementById('loginPage').style.display = 'flex';
        }
    });

    // ===== TAB NAVIGATION =====
    function showAdminTab(tab) {
        document.querySelectorAll('.admin-tab').forEach(t => t.style.display = 'none');
        const el = document.getElementById('tab-' + tab);
        if (el) el.style.display = 'block';
        document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.sidebar-btn').forEach(b => {
            if (b.getAttribute('onclick') === `showAdminTab('${tab}')`) b.classList.add('active');
        });
        if (tab === 'loans') renderPaginatedLoans();
        if (tab === 'members') renderMemberManager();
        if (tab === 'audit') renderAuditFull();
        if (tab === 'settings') {
            document.getElementById('setConfigAmount').value = appData.settings.contri;
            document.getElementById('setConfigInterest').value = appData.settings.interest;
            renderSettingsCycles();
        }
        if (tab === 'newloan') {
            document.getElementById('loanMemberSelect').innerHTML = appData.members.filter(m=>!m.banned).map(m => `<option value="${m.name}">${m.name}</option>`).join('');
            updateLoanPreview();
        }
    }

    // ===== RENDER ADMIN =====
    function renderAdmin() {
        const contri = Number(appData.settings.contri);
        const interest = Number(appData.settings.interest);

        // Stats
        let systemTotal = 0;
        appData.members.forEach(m => { systemTotal += getMemberContribution(m); });
        const activeLoanPrincipal = (appData.loans || []).reduce((a, l) => a + Number(l.principal), 0);
        const cash = systemTotal + (appData.profit || 0) - activeLoanPrincipal;
        const pool = systemTotal + (appData.profit || 0);

        document.getElementById('admCash').innerText = `₱${cash.toLocaleString()}`;
        document.getElementById('admLoans').innerText = `₱${activeLoanPrincipal.toLocaleString()}`;
        document.getElementById('admProfit').innerText = `₱${(appData.profit || 0).toLocaleString()}`;
        document.getElementById('admPool').innerText = `₱${pool.toLocaleString()}`;
        document.getElementById('sb_cash').innerText = `₱${cash.toLocaleString()}`;
        document.getElementById('sb_pool').innerText = `₱${pool.toLocaleString()}`;
        document.getElementById('sb_loans').innerText = `₱${activeLoanPrincipal.toLocaleString()}`;

        const loanCount = (appData.loans || []).length;
        document.getElementById('loanCountBadge').innerText = loanCount;
        document.getElementById('loanCountBadge').style.display = loanCount > 0 ? 'block' : 'none';
        document.getElementById('memberCountBadge').innerText = `${appData.members.length} Members`;
        document.getElementById('memberCountText').innerText = `${appData.members.length} registered members`;

        // Month chips
        document.getElementById('monthSelectors').innerHTML = appData.cycles.map(c =>
            `<span class="month-chip ${appData.hiddenMonths.includes(c) ? '' : 'active'}" onclick="toggleH('${c}')">${c}</span>`
        ).join('');

        // Ledger table
        let head = '<tr><th class="ps-3 text-start" style="min-width:160px">MEMBER</th>';
        appData.cycles.forEach(c => { if (!appData.hiddenMonths.includes(c)) head += `<th colspan="2" class="month-header border-start">${c}</th>`; });
        head += '<th class="border-start">TOTAL</th></tr>';
        document.getElementById('tableHead').innerHTML = head;

        let body = '';
        let columnTotals = new Array(appData.cycles.length * 2).fill(0);
        let systemTotalPrincipal = 0;

        appData.members.forEach((m, mi) => {
            const slots = m.slots || 1;
            let mSum = Number(m.carryOver || 0);
            let cells = `<td class="ps-3 member-name-cell ${m.banned ? 'opacity-50' : ''}"><b>${sanitize(m.name)}</b> <span class="slot-badge">${slots}x</span><br><small>${sanitize(m.email)}</small></td>`;
            m.payments.forEach((p, pi) => {
                const cy = appData.cycles[Math.floor(pi / 2)];
                if (p) { const a = contri * slots; mSum += a; columnTotals[pi] += a; }
                if (!appData.hiddenMonths.includes(cy)) {
                    cells += `<td class="${pi % 2 === 0 ? 'border-start' : ''}"><input type="checkbox" class="pay-checkbox" ${p ? 'checked' : ''} onchange="confirmPayment(${mi},${pi},this)"></td>`;
                }
            });
            systemTotalPrincipal += mSum;
            body += `<tr>${cells}<td class="fw-bold border-start" style="font-family:'DM Mono',monospace;font-size:0.82rem">₱${mSum.toLocaleString()}</td></tr>`;
        });
        document.getElementById('tableBody').innerHTML = body || `<tr><td colspan="99" class="text-center py-5 text-muted">No members enrolled</td></tr>`;

        let foot = '<tr><td class="ps-3 text-start" style="font-size:0.7rem">COLLECTED</td>';
        appData.cycles.forEach((c, ci) => {
            if (!appData.hiddenMonths.includes(c))
                foot += `<td class="border-start" style="font-size:0.72rem;font-family:'DM Mono',monospace">₱${columnTotals[ci * 2].toLocaleString()}</td><td style="font-size:0.72rem;font-family:'DM Mono',monospace">₱${columnTotals[ci * 2 + 1].toLocaleString()}</td>`;
        });
        document.getElementById('tableFoot').innerHTML = foot + `<td class="border-start" style="font-family:'DM Mono',monospace">₱${systemTotalPrincipal.toLocaleString()}</td></tr>`;

        // Member snapshot
        let snap = '';
        appData.members.forEach(m => {
            const c = getMemberContribution(m);
            const pct = systemTotal > 0 ? (c / systemTotal * 100).toFixed(1) : 0;
            snap += `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
                <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-light));display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:0.8rem;flex-shrink:0">${sanitize(m.name[0])}</div>
                <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:0.85rem">${sanitize(m.name)}</div><div style="height:5px;background:var(--bg);border-radius:99px;margin-top:4px"><div style="height:5px;background:var(--primary-light);border-radius:99px;width:${pct}%"></div></div></div>
                <div style="font-family:'DM Mono',monospace;font-size:0.82rem;font-weight:700;flex-shrink:0">₱${c.toLocaleString()}</div>
                <div style="font-size:0.7rem;color:var(--text3);width:40px;text-align:right">${pct}%</div>
            </div>`;
        });
        document.getElementById('memberSnapshotList').innerHTML = snap || '<div class="empty-state"><i class="fas fa-users"></i><p>No members yet</p></div>';

        // Audit overview
        const logs = (appData.logs || []).slice(0, 15);
        document.getElementById('auditLogListOverview').innerHTML = logs.map(l => `
            <div class="log-entry">
                <div class="log-meta"><span class="log-time">${sanitize(l.time)}</span><span class="log-admin">${sanitize(l.admin)}</span></div>
                <div class="log-action">${sanitize(l.act)}</div>
                <div class="log-balance">${sanitize(l.balance || '')}</div>
            </div>`).join('') || '<div class="empty-state"><i class="fas fa-history"></i><p>No activity yet</p></div>';

        renderPaginatedLoans();
    }

    function renderPaginatedLoans() {
        const loans = appData.loans || [];
        const totalPages = Math.ceil(loans.length / loansPerPage) || 1;
        if (currentLoanPage > totalPages) currentLoanPage = 1;
        const start = (currentLoanPage - 1) * loansPerPage;
        const pageLoans = loans.slice(start, start + loansPerPage);

        document.getElementById('loanSummaryText').innerText = loans.length === 0 ? 'No active loans' : `${loans.length} active loan${loans.length > 1 ? 's' : ''} — ₱${loans.reduce((a,l) => a+Number(l.principal),0).toLocaleString()} outstanding`;

        document.getElementById('loanLedgerList').innerHTML = pageLoans.map((l, idx) => {
            const oi = start + idx;
            const interest = l.principal * (appData.settings.interest / 100);
            return `<div class="loan-card">
                <div class="loan-card-header">
                    <div>
                        <div class="loan-borrower">${sanitize(l.borrower)}</div>
                        <div class="loan-ref">Ref #LN-${(oi + 100).toString().padStart(4,'0')} &bull; Released ${sanitize(l.date)}</div>
                    </div>
                    <span class="loan-badge"><i class="fas fa-circle" style="font-size:0.5rem;margin-right:4px"></i>ACTIVE</span>
                </div>
                <div class="loan-data">
                    <div class="loan-row"><span class="loan-lbl">Principal</span><span class="loan-val">₱${Number(l.principal).toLocaleString()}</span></div>
                    <div class="loan-row"><span class="loan-lbl">Interest (${appData.settings.interest}%)</span><span class="loan-val" style="color:var(--primary)">+₱${interest.toLocaleString()}</span></div>
                    <div class="loan-sep"></div>
                    <div class="loan-row"><span class="loan-lbl">Total Payable</span><span class="loan-total">₱${(l.principal + interest).toLocaleString()}</span></div>
                </div>
                <div class="loan-actions">
                    <button class="btn-amortize" onclick="openAmortize(${oi})"><i class="fas fa-coins me-1"></i>Amortize</button>
                    <button class="btn-settle" onclick="full(${oi})"><i class="fas fa-check-circle me-1"></i>Settle Full</button>
                </div>
            </div>`;
        }).join('') || '<div class="empty-state"><i class="fas fa-file-invoice"></i><p>No active loans</p></div>';

        document.getElementById('loanPaginationControls').innerHTML = loans.length > loansPerPage ? `
            <button class="page-btn" onclick="changeLoanPage(-1)" ${currentLoanPage === 1 ? 'disabled' : ''}>← Prev</button>
            <span class="page-info">Page ${currentLoanPage} / ${totalPages}</span>
            <button class="page-btn" onclick="changeLoanPage(1)" ${currentLoanPage === totalPages ? 'disabled' : ''}>Next →</button>` : '';

        // Analytics
        const totalPrincipal = loans.reduce((a,l) => a+Number(l.principal), 0);
        const totalInterest = loans.reduce((a,l) => a + Number(l.principal) * (appData.settings.interest/100), 0);
        document.getElementById('loanAnalytics').innerHTML = `
            <div class="quick-stat mb-2"><div class="qs-label">Active Loans</div><div class="qs-value">${loans.length}</div></div>
            <div class="quick-stat mb-2"><div class="qs-label">Total Principal</div><div class="qs-value">₱${totalPrincipal.toLocaleString()}</div></div>
            <div class="quick-stat mb-2"><div class="qs-label">Expected Interest</div><div class="qs-value" style="color:var(--success)">₱${totalInterest.toLocaleString()}</div></div>
            <div class="quick-stat"><div class="qs-label">Total Collectible</div><div class="qs-value">₱${(totalPrincipal + totalInterest).toLocaleString()}</div></div>`;
    }

    function changeLoanPage(step) { currentLoanPage += step; renderPaginatedLoans(); }

    function renderMemberManager() {
        const q = (document.getElementById('memberSearchInput')?.value || '').toLowerCase().trim();
        const members = appData.members.filter(m => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
        const hl = t => q ? t.replace(new RegExp(`(${q})`, 'gi'), '<mark>$1</mark>') : t;
        const empty = document.getElementById('memberManagerEmpty');
        const tbody = document.getElementById('memberManagerBody');
        if (!members.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
        empty.style.display = 'none';
        let systemTotal = 0;
        appData.members.forEach(m => systemTotal += getMemberContribution(m));
        tbody.innerHTML = members.map((m, i) => {
            const ri = appData.members.indexOf(m);
            const c = getMemberContribution(m);
            return `<tr>
                <td style="padding-left:1.5rem"><b>${hl(sanitize(m.name))}</b><br><small style="color:var(--text3)">${hl(sanitize(m.email))}</small></td>
                <td><span class="slot-badge">${sanitize(m.slots || 1)}x</span></td>
                <td style="font-family:'DM Mono',monospace;font-size:0.8rem">₱${Number(m.carryOver||0).toLocaleString()}</td>
                <td style="font-family:'DM Mono',monospace;font-size:0.8rem">₱${c.toLocaleString()}</td>
                <td><span class="status-pill ${m.banned ? 'banned' : 'active'}">${m.banned ? 'Banned' : 'Active'}</span></td>
                <td style="text-align:right;padding-right:1.5rem">
                    <button class="action-btn" title="Edit Member" onclick="openEditMember(${ri})"><i class="fas fa-pen"></i></button>
                    <button class="action-btn warn" title="${m.banned ? 'Unban' : 'Ban'}" onclick="banM(${ri})">${m.banned ? '<i class="fas fa-user-check"></i>' : '<i class="fas fa-ban"></i>'}</button>
                    <button class="action-btn danger" title="Delete Member" onclick="deleteM(${ri})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>`;
        }).join('');
    }

    function renderAuditFull() {
        document.getElementById('auditLogFull').innerHTML = (appData.logs || []).map(l => `
            <div class="log-entry">
                <div class="log-meta"><span class="log-time">${sanitize(l.time)}</span><span class="log-admin">${sanitize(l.admin)}</span><span class="log-balance">${sanitize(l.balance || '')}</span></div>
                <div class="log-action">${sanitize(l.act)}</div>
            </div>`).join('') || '<div class="empty-state"><i class="fas fa-history"></i><p>No logs yet</p></div>';
    }

    // ===== MEMBER DASHBOARD =====
    function renderMember(user) {
        const m = appData.members.find(x => x.email.toLowerCase() === user.email.toLowerCase());
        if (!m) return;

        // System totals
        let totalSys = 0;
        appData.members.forEach(me => { totalSys += getMemberContribution(me); });
        const activeLoanPrincipal = (appData.loans || []).reduce((a, l) => a + Number(l.principal), 0);
        const systemCash = totalSys + (appData.profit || 0) - activeLoanPrincipal;

        // Member calcs
        const myC = getMemberContribution(m);
        const myShare = totalSys > 0 ? (myC / totalSys * (appData.profit || 0)) : 0;
        const sharePct = totalSys > 0 ? (myC / totalSys * 100) : 0;
        const myLoan = appData.loans.find(l => l.borrower === m.name);
        const myLoanPrincipal = myLoan ? Number(myLoan.principal) : 0;
        const myLoanInterest = myLoanPrincipal * (appData.settings.interest / 100);
        const myLoanTotal = myLoanPrincipal + myLoanInterest;
        const netEquity = myC + myShare - myLoanTotal;

        // Payment counts
        const paidCount = (m.payments || []).filter(Boolean).length;
        const totalCount = (m.payments || []).length;
        const pendingCount = totalCount - paidCount;
        const completionPct = totalCount > 0 ? Math.round(paidCount / totalCount * 100) : 0;

        // Hero section
        document.getElementById('mDashName').innerText = m.name;
        document.getElementById('mDashSlotLabel').innerText = `${m.slots || 1} Slot(s)`;
        document.getElementById('mDashEmail').innerText = m.email;
        document.getElementById('mDashPaidCount').innerText = paidCount;
        document.getElementById('mDashPendingCount').innerText = pendingCount;
        document.getElementById('mDashSharePct').innerText = `${sharePct.toFixed(1)}%`;

        // Equity
        document.getElementById('mDashTotalEquity').innerText = `₱${netEquity.toLocaleString(undefined, {maximumFractionDigits:0})}`;

        // Fund cards
        document.getElementById('mDashContri').innerText = `₱${myC.toLocaleString()}`;
        document.getElementById('mDashContriSub').innerText = m.carryOver > 0 ? `Incl. ₱${Number(m.carryOver).toLocaleString()} carry-over` : 'From contributions only';
        document.getElementById('mDashShare').innerText = `₱${myShare.toLocaleString(undefined, {maximumFractionDigits:0})}`;
        document.getElementById('mDashShareSub').innerText = `${sharePct.toFixed(2)}% of total fund`;
        document.getElementById('mDashLoan').innerText = myLoanTotal > 0 ? `₱${myLoanTotal.toLocaleString()}` : '₱0';
        document.getElementById('mDashLoanSub').innerText = myLoan ? `Principal + ${appData.settings.interest}% interest` : 'No active loan';

        // Fund health
        document.getElementById('mFundTotal').innerText = `₱${(totalSys + (appData.profit || 0)).toLocaleString()}`;
        document.getElementById('mFundProfit').innerText = `₱${(appData.profit || 0).toLocaleString()}`;
        document.getElementById('mFundCash').innerText = `₱${systemCash.toLocaleString()}`;
        document.getElementById('mFundLoans').innerText = `₱${activeLoanPrincipal.toLocaleString()}`;
        document.getElementById('mSharePctLabel').innerText = `${sharePct.toFixed(1)}%`;
        document.getElementById('mShareBar').style.width = `${Math.min(sharePct, 100)}%`;
        const healthBadge = document.getElementById('mFundHealthBadge');
        const ratio = totalSys > 0 ? activeLoanPrincipal / (totalSys + (appData.profit || 0)) : 0;
        if (ratio < 0.4) { healthBadge.innerText = 'Healthy'; healthBadge.className = 'status-pill active'; }
        else if (ratio < 0.7) { healthBadge.innerText = 'Moderate'; healthBadge.className = 'status-pill'; healthBadge.style.background='#fef3c7'; healthBadge.style.color='#92400e'; }
        else { healthBadge.innerText = 'High Exposure'; healthBadge.className = 'status-pill banned'; }

        // Loan panel toggle
        if (myLoan) {
            document.getElementById('mLoanPanel').style.display = 'block';
            document.getElementById('mNoLoanPanel').style.display = 'none';
            document.getElementById('mLoanBorrower').innerText = myLoan.borrower;
            document.getElementById('mLoanPrincipal').innerText = `₱${myLoanPrincipal.toLocaleString()}`;
            document.getElementById('mLoanRate').innerText = appData.settings.interest;
            document.getElementById('mLoanInterest').innerText = `₱${myLoanInterest.toLocaleString()}`;
            document.getElementById('mLoanTotal').innerText = `₱${myLoanTotal.toLocaleString()}`;
            document.getElementById('mLoanDate').innerText = myLoan.date || '—';
        } else {
            document.getElementById('mLoanPanel').style.display = 'none';
            document.getElementById('mNoLoanPanel').style.display = 'block';
        }

        // Payment summary
        document.getElementById('mPaymentSummary').innerText = `${paidCount} / ${totalCount} Paid`;
        document.getElementById('mPaymentSummary').className = `status-pill ${paidCount === totalCount && totalCount > 0 ? 'active' : ''}`;
        document.getElementById('mPayCompletionPct').innerText = `${completionPct}%`;
        document.getElementById('mPayCompletionBar').style.width = `${completionPct}%`;

        // Payment grid
        document.getElementById('paymentTimeline').innerHTML = (m.payments || []).map((p, i) => `
            <div class="payment-box ${p ? 'paid' : 'pending'}">
                <div class="pb-cycle">${appData.cycles[Math.floor(i / 2)] || ''} ${i % 2 === 0 ? '15th' : '30th'}</div>
                <div class="pb-icon">${p ? '✅' : '⬜'}</div>
                <div class="pb-status">${p ? 'PAID' : 'PENDING'}</div>
            </div>`).join('') || '<div class="empty-state"><i class="fas fa-calendar"></i><p>No payment cycles yet</p></div>';
    }

    // ===== PAYMENT CONFIRMATION =====
    function confirmPayment(mi, pi, checkbox) {
        const m = appData.members[mi];
        const cycle = appData.cycles[Math.floor(pi / 2)];
        const day = pi % 2 === 0 ? "15th" : "30th";
        const willPay = !m.payments[pi];
        const actionText = willPay ? "mark as PAID" : "remove payment for";
        showConfirm(
            willPay ? 'Confirm Payment' : 'Remove Payment',
            `${actionText} ${m.name} — ${cycle} ${day}?`,
            () => {
                appData.members[mi].payments[pi] = willPay;
                logAction(`${m.name}: ${willPay ? 'Payment confirmed' : 'Payment removed'} — ${cycle} ${day}`);
                save();
                notify(willPay ? `Payment recorded for ${m.name}` : `Payment removed for ${m.name}`);
                renderAdmin();
            },
            willPay ? 'success' : 'danger',
            willPay ? '💰' : '⚠️'
        );
        checkbox.checked = m.payments[pi]; // revert until confirmed
    }

    // ===== TOGGLE MONTH =====
    function toggleH(m) {
        if (appData.hiddenMonths.includes(m)) appData.hiddenMonths = appData.hiddenMonths.filter(x => x !== m);
        else appData.hiddenMonths.push(m);
        renderAdmin();
    }

    // ===== ADD MEMBER =====
    function openAddMemberModal() {
        document.getElementById('newMemberName').value = '';
        document.getElementById('newMemberEmail').value = '';
        document.getElementById('newMemberSlots').value = 1;
        document.getElementById('newMemberCarryOver').value = 0;
        selectedNewSlots = 1;
        selectSlots(1);
        updateNewMemberPreview();
        new bootstrap.Modal(document.getElementById('addMemberModal')).show();
    }

    function selectSlots(n) {
        selectedNewSlots = n;
        document.getElementById('newMemberSlots').value = n;
        [1,2,3].forEach(i => {
            const el = document.getElementById('slot' + i);
            if (el) el.classList.toggle('selected', i === n);
        });
        updateNewMemberPreview();
    }

    function updateNewMemberPreview() {
        const slots = Number(document.getElementById('newMemberSlots')?.value || 1);
        document.getElementById('previewContri').innerText = `₱${(appData.settings.contri * slots).toLocaleString()} / payment`;
        document.getElementById('previewSlots').innerText = `${slots} slot(s)`;
    }

    document.addEventListener('input', e => { if (e.target.id === 'newMemberSlots') { selectedNewSlots = Number(e.target.value); updateNewMemberPreview(); }});

    function addMember() {
        const name = document.getElementById('newMemberName').value.trim();
        const email = document.getElementById('newMemberEmail').value.trim().toLowerCase();
        const slots = Number(document.getElementById('newMemberSlots').value) || 1;
        const carryOver = Number(document.getElementById('newMemberCarryOver').value) || 0;

        if (!name) { notify('Please enter a full name', 'error'); return; }
        if (!email || !email.includes('@')) { notify('Please enter a valid email', 'error'); return; }
        if (appData.members.some(m => m.email === email)) { notify('Email already registered', 'error'); return; }

        appData.members.push({
            name, email, slots, carryOver,
            payments: new Array(appData.cycles.length * 2).fill(false),
            banned: false
        });
        logAction(`Enrolled: ${name} (${slots} slot${slots > 1 ? 's' : ''})`);
        save();
        notify(`✓ ${name} enrolled successfully!`);
        bootstrap.Modal.getInstance(document.getElementById('addMemberModal'))?.hide();
        renderAdmin();
        if (document.getElementById('tab-members').style.display !== 'none') renderMemberManager();
    }

    // ===== EDIT MEMBER =====
    function openEditMember(i) {
        const m = appData.members[i];
        document.getElementById('editMemberIndex').value = i;
        document.getElementById('editMemberName').value = m.name;
        document.getElementById('editMemberEmail').value = m.email;
        document.getElementById('editMemberSlots').value = m.slots || 1;
        document.getElementById('editMemberCarryOver').value = m.carryOver || 0;
        new bootstrap.Modal(document.getElementById('editMemberModal')).show();
    }

    function saveEditMember() {
        const i = Number(document.getElementById('editMemberIndex').value);
        const name = document.getElementById('editMemberName').value.trim();
        const email = document.getElementById('editMemberEmail').value.trim().toLowerCase();
        const slots = Number(document.getElementById('editMemberSlots').value);
        const carryOver = Number(document.getElementById('editMemberCarryOver').value);
        if (!name || !email) { notify('Name and email are required', 'error'); return; }
        appData.members[i] = { ...appData.members[i], name, email, slots, carryOver };
        logAction(`Member updated: ${name}`);
        save();
        notify(`${name} updated`);
        bootstrap.Modal.getInstance(document.getElementById('editMemberModal'))?.hide();
        renderAdmin();
        renderMemberManager();
    }

    function banM(i) {
        const m = appData.members[i];
        const action = m.banned ? 'unban' : 'ban';
        showConfirm(`${m.banned ? 'Unban' : 'Ban'} Member`, `Are you sure you want to ${action} ${m.name}?`, () => {
            appData.members[i].banned = !m.banned;
            logAction(`${m.banned ? 'Banned' : 'Unbanned'}: ${m.name}`);
            save(); renderAdmin(); renderMemberManager();
            notify(`${m.name} ${appData.members[i].banned ? 'banned' : 'unbanned'}`);
        }, m.banned ? 'success' : 'danger');
    }

    function deleteM(i) {
        const m = appData.members[i];
        showConfirm('Delete Member', `Permanently delete ${m.name}? This cannot be undone.`, () => {
            logAction(`Deleted: ${m.name}`);
            appData.members.splice(i, 1);
            save(); renderAdmin(); renderMemberManager();
            notify(`${m.name} removed`);
        });
    }

    // ===== LOANS =====
    function selectLoanType(type) {
        currentLoanType = type;
        document.getElementById('typeOptionMember').classList.toggle('selected', type === 'member');
        document.getElementById('typeOptionGuest').classList.toggle('selected', type === 'guest');
        document.getElementById('memberSelectWrap').classList.toggle('d-none', type === 'guest');
        document.getElementById('guestInputWrap').classList.toggle('d-none', type === 'member');
    }

    function updateLoanPreview() {
        const amt = Number(document.getElementById('loanAmtInput')?.value || 0);
        const preview = document.getElementById('loanPreview');
        if (amt > 0) {
            const interest = amt * (appData.settings.interest / 100);
            document.getElementById('previewPrincipal').innerText = `₱${amt.toLocaleString()}`;
            document.getElementById('previewInterest').innerText = `₱${interest.toLocaleString()}`;
            document.getElementById('previewTotal').innerText = `₱${(amt + interest).toLocaleString()}`;
            document.getElementById('previewRate').innerText = appData.settings.interest;
            preview.style.display = 'flex';
        } else {
            preview.style.display = 'none';
        }
    }

    document.addEventListener('input', e => { if (e.target.id === 'loanAmtInput') updateLoanPreview(); });

    function releaseLoan() {
        const type = currentLoanType;
        const name = type === 'member' ? document.getElementById('loanMemberSelect').value : document.getElementById('guestNameInput').value.trim();
        const amt = Number(document.getElementById('loanAmtInput').value);
        if (!name) { notify('Please select/enter a borrower', 'error'); return; }
        if (amt <= 0) { notify('Please enter a valid loan amount', 'error'); return; }
        showConfirm('Approve Loan', `Release ₱${amt.toLocaleString()} to ${name}?`, () => {
            const d = new Date();
            appData.loans.push({ borrower: name, principal: amt, date: `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}` });
            logAction(`Loan Issued: ₱${amt.toLocaleString()} to ${name}`);
            save();
            notify(`Loan of ₱${amt.toLocaleString()} released to ${name}`);
            document.getElementById('loanAmtInput').value = '';
            document.getElementById('loanPreview').style.display = 'none';
            showAdminTab('loans');
        }, 'danger', '💸');
    }

    function openAmortize(i) {
        const l = appData.loans[i];
        document.getElementById('amortizeLoanIndex').value = i;
        document.getElementById('amortizeDesc').innerText = `${l.borrower} — Current balance: ₱${Number(l.principal).toLocaleString()}`;
        document.getElementById('amortizeAmount').value = '';
        document.getElementById('amortizeAmount').max = l.principal;
        new bootstrap.Modal(document.getElementById('amortizeModal')).show();
    }

    function submitAmortize() {
        const i = Number(document.getElementById('amortizeLoanIndex').value);
        const amt = Number(document.getElementById('amortizeAmount').value);
        const loan = appData.loans[i];
        if (amt <= 0 || amt > loan.principal) { notify('Invalid amount', 'error'); return; }
        appData.profit += amt * (appData.settings.interest / 100);
        appData.loans[i].principal -= amt;
        logAction(`Amortization: ${loan.borrower} paid ₱${amt.toLocaleString()}`);
        if (appData.loans[i].principal <= 0) { appData.loans.splice(i, 1); notify(`${loan.borrower} loan fully settled!`); }
        else notify(`Payment of ₱${amt.toLocaleString()} recorded`);
        save();
        bootstrap.Modal.getInstance(document.getElementById('amortizeModal'))?.hide();
        renderAdmin();
    }

    function full(i) {
        const loan = appData.loans[i];
        showConfirm('Settle Full Loan', `Mark ₱${Number(loan.principal).toLocaleString()} from ${loan.borrower} as fully settled?`, () => {
            appData.profit += loan.principal * (appData.settings.interest / 100);
            logAction(`Loan Cleared: ${loan.borrower}`);
            appData.loans.splice(i, 1);
            save(); notify(`${loan.borrower}'s loan settled`); renderAdmin();
        }, 'success', '✅');
    }

    // ===== SETTINGS CYCLE RENDER =====
    function renderSettingsCycles() {
        const chips = document.getElementById('settingsCycleChips');
        const badge = document.getElementById('cycleCountBadge');
        const removeBtn = document.getElementById('settingsRemoveMonthBtn');
        if (!chips) return;
        if (badge) badge.innerText = `${appData.cycles.length} Cycle${appData.cycles.length !== 1 ? 's' : ''}`;
        chips.innerHTML = appData.cycles.map((c, i) => `
            <span style="display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:8px;font-size:0.72rem;font-weight:700;background:${i === appData.cycles.length - 1 ? '#dbeafe' : 'var(--bg)'};color:${i === appData.cycles.length - 1 ? 'var(--primary)' : 'var(--text2)'};border:1px solid ${i === appData.cycles.length - 1 ? '#93c5fd' : 'var(--border)'};">
                ${i === appData.cycles.length - 1 ? '<i class="fas fa-arrow-right" style="font-size:0.55rem"></i>' : ''} ${c}
            </span>`).join('');
        if (removeBtn) removeBtn.disabled = appData.cycles.length <= 1;
    }

    function confirmAddMonth() {
        const last = appData.cycles[appData.cycles.length - 1];
        const next = monthNames[(monthNames.indexOf(last) + 1) % 12];
        showConfirm('Add Month Cycle', `Add "${next}" as the next payment cycle? This will add 2 payment slots (15th & 30th) for all ${appData.members.length} member(s).`, () => {
            autoAddNextMonth();
            renderSettingsCycles();
        }, 'success', '📅');
    }

    function confirmRemoveMonth() {
        if (appData.cycles.length <= 1) { notify('Cannot remove the only remaining month', 'error'); return; }
        const last = appData.cycles[appData.cycles.length - 1];
        const hasPayments = appData.members.some(m => {
            const len = (m.payments || []).length;
            return len >= 2 && (m.payments[len - 1] || m.payments[len - 2]);
        });
        const msg = hasPayments
            ? `⚠️ Some members have payments recorded for "${last}". Removing this month will PERMANENTLY delete those payment records. Are you absolutely sure?`
            : `Remove the month cycle "${last}"? This will remove the two payment slots (15th & 30th) for all members.`;
        showConfirm(`Remove "${last}"?`, msg, () => {
            removeLastMonth();
            renderSettingsCycles();
        }, 'danger', '🗑️');
    }

    // ===== MONTH CYCLE =====
    function autoAddNextMonth() {
        const last = appData.cycles[appData.cycles.length - 1];
        const next = monthNames[(monthNames.indexOf(last) + 1) % 12];
        appData.cycles.push(next);
        appData.members.forEach(m => { if (!m.payments) m.payments = []; m.payments.push(false, false); });
        logAction(`New Cycle Added: ${next}`);
        save();
        notify(`Month "${next}" added`);
    }

    function removeLastMonth() {
        if (appData.cycles.length <= 1) { notify('Cannot remove the only remaining month', 'error'); return; }
        const last = appData.cycles[appData.cycles.length - 1];
        // Check if the last month has any payments recorded
        const hasPayments = appData.members.some(m => {
            const len = (m.payments || []).length;
            return len >= 2 && (m.payments[len - 1] || m.payments[len - 2]);
        });
        const doRemove = () => {
            appData.cycles.pop();
            appData.members.forEach(m => {
                if (m.payments && m.payments.length >= 2) {
                    m.payments.splice(-2, 2);
                }
            });
            logAction(`Cycle Removed: ${last}`);
            save();
            notify(`Month "${last}" removed`);
            renderAdmin();
        };
        if (hasPayments) {
            showConfirm(
                `Remove "${last}"?`,
                `Some members have payments recorded for ${last}. Removing this month will delete those payment records permanently.`,
                doRemove,
                'danger',
                '⚠️'
            );
        } else {
            doRemove();
        }
    }

    // ===== SETTINGS =====
    function updateSettings() {
        const contri = Number(document.getElementById('setConfigAmount').value);
        const interest = Number(document.getElementById('setConfigInterest').value);
        if (contri <= 0 || interest < 0) { notify('Invalid settings values', 'error'); return; }
        appData.settings.contri = contri;
        appData.settings.interest = interest;
        logAction(`Settings Updated: ₱${contri} contribution, ${interest}% interest`);
        save();
        notify('Settings saved');
    }

    // ===== EXPORTS =====
    function exportAuditLog() {
        let csv = "TIMESTAMP,ADMIN,ACTION,BALANCE\n";
        (appData.logs || []).forEach(l => {
            csv += `"${l.time}","${l.admin}","${l.act.replace(/"/g,'""')}","${l.balance || ''}"\n`;
        });
        downloadFile(csv, `MSF_AuditLog_${today()}.csv`, 'text/csv');
        notify('Audit log exported');
    }

    function exportFullSpreadsheet() {
        let csv = "--- MEMBER FINANCIAL SUMMARY ---\nNAME,EMAIL,SLOTS,CARRY OVER,TOTAL CONTRIBUTION,DIVIDEND SHARE,TOTAL EQUITY\n";
        let totalSys = 0;
        appData.members.forEach(m => { totalSys += getMemberContribution(m); });
        appData.members.forEach(m => {
            const c = getMemberContribution(m);
            const share = totalSys > 0 ? (c / totalSys * (appData.profit || 0)) : 0;
            csv += `"${m.name}","${m.email}",${m.slots||1},${m.carryOver||0},${c},${share.toFixed(2)},${(c + share).toFixed(2)}\n`;
        });
        csv += "\n--- CONTRIBUTION LEDGER ---\nNAME";
        appData.cycles.forEach(c => { csv += `,"${c} 15th","${c} 30th"`; });
        csv += "\n";
        appData.members.forEach(m => {
            csv += `"${m.name}"`;
            (m.payments || []).forEach(p => { csv += `,"${p ? 'PAID' : 'UNPAID'}"`; });
            csv += "\n";
        });
        csv += "\n--- AUDIT LOGS ---\nTIMESTAMP,ADMIN,ACTION,BALANCE\n";
        (appData.logs || []).forEach(l => { csv += `"${l.time}","${l.admin}","${l.act.replace(/"/g,'""')}","${l.balance||''}"\n`; });
        downloadFile(csv, `MSF_FullReport_${today()}.csv`, 'text/csv;charset=utf-8;');
        notify('Full spreadsheet exported');
    }

    function exportBackup() {
        downloadFile(JSON.stringify(appData, null, 2), `MSF_Backup_${today()}.json`, 'application/json');
        notify('Backup exported');
    }

    function importBackup() {
        const file = document.getElementById('importFile').files[0];
        if (!file) return;
        const r = new FileReader();
        r.onload = e => {
            try {
                const parsed = JSON.parse(e.target.result);
                showConfirm('Restore Backup', 'This will overwrite ALL current data with the backup file. This cannot be undone. Continue?', () => {
                    appData = parsed; save(); notify('System Restored from backup');
                }, 'danger', '📂');
            } catch (err) { notify('Invalid backup file', 'error'); }
        };
        r.readAsText(file);
    }

    function importBackupFromSettings(event) {
        const file = event.target.files[0];
        if (!file) return;
        const r = new FileReader();
        r.onload = e => {
            try {
                const parsed = JSON.parse(e.target.result);
                showConfirm('Restore Backup', 'This will overwrite ALL current data with the backup file. This cannot be undone. Continue?', () => {
                    appData = parsed; save(); notify('System Restored from backup');
                }, 'danger', '📂');
            } catch (err) { notify('Invalid backup file', 'error'); }
        };
        r.readAsText(file);
    }

    async function secureSystemWipe() {
        const pin = prompt("Enter Security PIN:");
        if (pin === null) return;
        const encoder = new TextEncoder();
        const data = encoder.encode(pin);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        if (hashHex === WIPE_PIN_HASH) {
            showConfirm('SYSTEM HARD RESET', 'DANGER: This will permanently delete ALL financial records. This cannot be undone.', async () => {
                await db.collection("system").doc("main").set({ settings: { contri: 100, interest: 5 }, members: [], cycles: ["Jan"], loans: [], profit: 0, logs: [], hiddenMonths: [] });
                location.reload();
            }, 'danger', '💣');
        } else {
            notify('Incorrect PIN', 'error');
        }
    }

    function downloadFile(content, filename, type) {
        const blob = new Blob([content], { type });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
    }

    function today() { return new Date().toISOString().split('T')[0]; }
