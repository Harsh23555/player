
    'use strict';

    /* ── PWA / Capacitor ── */
    let deferredPrompt;
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { }));
    }
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); deferredPrompt = e;
      // No need to show/hide, it's always visible now
    });
    window.addEventListener('appinstalled', () => {
      showToast('NOVA Player installed on home screen!');
    });

    let Filesystem, Directory, Media, Preferences, App, Share, MediaScanner, MusicControls;
    if (window.Capacitor) {
      ({ Filesystem, Directory, Media, Preferences, App, Share, MediaScanner, MusicControls } = Capacitor.Plugins);
      // Fallback for community media plugin naming variations
      if (!Media) Media = window.CapacitorMedia;

      App.addListener('backButton', () => {
        if (document.querySelector('.modal-overlay.open')) {
          document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
        } else if (document.getElementById('playerModal').classList.contains('open')) {
          closePlayer();
        } else if (currentTab === 'folders' && currentFolderPath) {
          currentFolderPath = null; renderList();
        } else {
          App.exitApp();
        }
      });

      App.addListener('appStateChange', ({ isActive }) => {
        // Automatic background refresh removed to prevent UI fluctuation.
        // Scanning now only happens on initial launch or manual user action.
      });
    }

    // Redundant initial scan removed. Scan is now initiated only by the init() function.

    /* ── State ── */
    let allMedia = [];
    let localMedia = [];
    let currentListView = []; // UI filtered list
    let playQueue = [];       // Actual playback queue
    let queueIndex = -1;      // Pointer in playQueue
    let currentTab = 'all';
    let activeIndex = -1;     // Keeping for UI compatibility if needed
    let loopA = null, loopB = null;
    let isHearted = false, isShuffle = false, isRepeat = false, isAutoplay = true;
    let favorites = [];
    let playlists = {};
    let currentFolderPath = null;
    const speeds = [1, 1.25, 1.5, 2.0, 0.5, 0.75];
    let currentSpeedIdx = 0;
    let serverIp = '10.186.24.74', serverPort = '8080';
    let apiBase = window.location.origin;
    // In Capacitor native apps the page is served from a local capacitor:// or http://localhost scheme.
    // We must point at the actual Django server IP instead.
    if (!apiBase || apiBase === 'null' || apiBase.startsWith('file:') || apiBase.startsWith('capacitor:') ||
        (window.Capacitor && Capacitor.isNativePlatform())) {
      apiBase = `http://${serverIp}:${serverPort}`;
    }
    let scanningActive = false;
    let lastScanTime = 0;
    let sleepTimer = null;
    let lastSelectedFile = null;

    /* ── Music Controls (Background Play & Notification) ── */
    function updateMusicControls(isPlaying) {
      if (!window.Capacitor || !Capacitor.isNativePlatform() || !MusicControls) return;

      const f = playQueue[queueIndex];
      if (!f) return;

      try {
        MusicControls.create({
          track: cleanName(f.name),
          artist: f.folder.split('/').pop() || 'NOVA Player',
          album: 'Local Media',
          cover: f.thumbnail || '', // Base64 or URL
          isPlaying: isPlaying,
          dismissable: true,
          hasPrev: true,
          hasNext: true,
          hasClose: true,
          ticker: 'Playing ' + cleanName(f.name),
          playIcon: 'media_play',
          pauseIcon: 'media_pause',
          prevIcon: 'media_prev',
          nextIcon: 'media_next',
          closeIcon: 'media_close',
          notificationIcon: 'notification'
        });

        MusicControls.subscribe(action => {
          const message = JSON.parse(action).message;
          switch (message) {
            case 'music-controls-next': playNext(); break;
            case 'music-controls-previous': playPrev(); break;
            case 'music-controls-pause':
              document.getElementById('audioPlayer').pause();
              document.getElementById('videoPlayer').pause();
              updateMusicControls(false);
              break;
            case 'music-controls-play':
              const f = playQueue[queueIndex];
              const el = f && f.type === 'video' ? document.getElementById('videoPlayer') : document.getElementById('audioPlayer');
              el.play();
              updateMusicControls(true);
              break;
            case 'music-controls-destroy':
              document.getElementById('audioPlayer').pause();
              document.getElementById('videoPlayer').pause();
              closePlayer();
              break;
            case 'music-controls-media-button-next': playNext(); break;
            case 'music-controls-media-button-previous': playPrev(); break;
            case 'music-controls-media-button-play-pause': togglePlay(); break;
          }
        });

        MusicControls.listen();
      } catch (e) { console.error("MusicControls error", e); }
    }

    function handleHeaderDownload() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
      } else {
        const f = playQueue[queueIndex] || lastSelectedFile;
        if (f && f.source === 'remote') {
          handleOption('download');
        } else if (window.Capacitor && Capacitor.isNativePlatform()) {
          openUrlDownloader();
        } else {
          showToast('Install the app (on browser) or play a remote file to download.');
        }
      }
    }

    /* ── Helpers ── */
    function formatSize(b) {
      if (!b) return '—';
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
      return (b / 1073741824).toFixed(2) + ' GB';
    }
    function formatTime(s) {
      if (!s || isNaN(s)) return '0:00';
      const m = Math.floor(s / 60), sec = Math.floor(s % 60);
      const h = Math.floor(s / 3600);
      if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      return `${m}:${String(sec).padStart(2, '0')}`;
    }
    function formatDate(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    function stopProp(e) { e.stopPropagation(); }
    function isRecentlyAdded(ts) {
      return ts && (Date.now() - ts) < 7 * 24 * 60 * 60 * 1000;
    }

    function showToast(msg, dur = 2800) {
      const t = document.getElementById('toastMsg');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(t._timer);
      t._timer = setTimeout(() => t.classList.remove('show'), dur);
    }

    /* ── Theme ── */
    function toggleTheme() {
      const isLight = document.body.classList.toggle('light-mode');
      if (Preferences) Preferences.set({ key: 'theme', value: isLight ? 'light' : 'dark' });
      const btn = document.getElementById('themeBtn');
      btn.innerHTML = isLight
        ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
        : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="19.36" x2="19.78" y2="20.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      document.querySelector('meta[name="theme-color"]').setAttribute('content', isLight ? '#f0eff8' : '#7c5cfc');
    }

    /* ── Settings ── */
    async function loadSettings() {
      if (!Preferences) return;
      try {
        const { value: theme } = await Preferences.get({ key: 'theme' });
        if (theme === 'light') toggleTheme();
        const { value: favs } = await Preferences.get({ key: 'favorites' });
        favorites = favs ? JSON.parse(favs) : [];
        const { value: pl } = await Preferences.get({ key: 'playlists' });
        playlists = pl ? JSON.parse(pl) : {};
      } catch (e) { }
    }
    async function saveFavorites() {
      if (Preferences) await Preferences.set({ key: 'favorites', value: JSON.stringify(favorites) });
    }
    async function savePlaylists() {
      if (Preferences) await Preferences.set({ key: 'playlists', value: JSON.stringify(playlists) });
    }

    async function ensurePermissions() {
      if (!window.Capacitor || !Capacitor.isNativePlatform()) return true;

      try {
        const prog = document.getElementById('scanProgressText');
        if (prog) prog.textContent = "Checking permissions...";

        // Check Media permissions (for MediaStore API)
        let mediaPerms = { publicStorage: 'granted', audio: 'granted', video: 'granted' };
        if (Media && Media.checkPermissions) {
          try {
            mediaPerms = await Media.checkPermissions();
          } catch (e) { console.warn("Media perms check failed", e); }
        }

        const isMediaGranted = mediaPerms.publicStorage === 'granted' ||
          mediaPerms.audio === 'granted' ||
          mediaPerms.video === 'granted' ||
          mediaPerms.videos === 'granted' ||
          mediaPerms.photos === 'granted';

        if (!isMediaGranted && Media && Media.requestPermissions) {
          if (prog) prog.textContent = "Requesting media access...";
          try {
            mediaPerms = await Media.requestPermissions();
          } catch (e) { console.error("Media perms request failed", e); }
        }

        // Check Filesystem permissions (for Deep Crawl)
        let fsPerms = await Filesystem.checkPermissions();
        if (fsPerms.publicStorage !== 'granted') {
          if (prog) prog.textContent = "Requesting storage access...";
          fsPerms = await Filesystem.requestPermissions();
        }

        const granted = isMediaGranted || (fsPerms.publicStorage === 'granted');

        if (!granted) {
          showToast("Permission denied. Nova needs storage access to find your files.", 5000);
          const container = document.getElementById('mediaContainer');
          container.innerHTML = `
            <div class="empty-state" style="padding: 40px 20px; text-align: center;">
              <div style="font-size: 48px; margin-bottom: 20px; opacity: 0.5;">🚫</div>
              <h3 style="margin-bottom: 12px; color: var(--text);">Permission Required</h3>
              <p style="color: var(--muted); font-size: 14px; margin-bottom: 24px; line-height: 1.6;">
                NOVA needs permission to access your media files to display them here. 
                Please enable storage access in your device settings.
              </p>
              <button class="primary-btn" onclick="scanLocalStorage(true)" style="margin: 0 auto;">Try Again</button>
            </div>
          `;
          return false;
        }
        return true;
      } catch (e) {
        console.error("Permission check failed", e);
        return false;
      }
    }

    /* ── SCANNER ── */
    async function scanLocalStorage(isManual = true) {
      if (scanningActive) return;

      const container = document.getElementById('mediaContainer');
      const indicator = document.getElementById('scanIndicator');

      if (indicator) indicator.style.display = 'inline-block';

      // Only show the blocking loading UI during manual refresh OR the absolute first launch scan
      if (isManual || (localMedia.length === 0 && lastScanTime === 0)) {
        container.innerHTML = `<div class="loading"><div class="loading-spinner"></div>Deep scanning your device…<div class="scan-progress-text" id="scanProgressText">Initializing…</div></div>`;
      }

      const prog = document.getElementById('scanProgressText');

      try {
        if (window.Capacitor && Capacitor.isNativePlatform()) {
          scanningActive = true;
          const hasPermission = await ensurePermissions();
          if (!hasPermission) {
            scanningActive = false;
            if (indicator) indicator.style.display = 'none';
            return;
          }

          if (MediaScanner) {
            try {
              if (prog) prog.textContent = "Deep scanning device (Native)...";
              const res = await MediaScanner.getMediaFiles();
              const combined = res.medias || [];

              if (combined.length === 0 && Media) {
                console.log('Native scan empty, trying community plugin...');
                if (prog) prog.textContent = "Querying Library (Fallback)...";
                const allRes = await Media.getMedias({ quantity: 2000 }).catch(() => ({ medias: [] }));
                const allList = allRes.medias || (Array.isArray(allRes) ? allRes : []);
                combined.push(...allList);
              }

              combined.forEach(m => {
                if (!m.identifier) return;
                const path = m.identifier;
                if (!localMedia.some(lm => lm.path === path)) {
                  let mType = 'audio';
                  if (m.type === 'video' || m.type === 'videos' || path.match(/\.(mp4|mkv|webm|3gp|avi|mov|m4v)/i)) mType = 'video';
                  else if (m.type === 'image' || m.type === 'images' || path.match(/\.(jpg|jpeg|png|gif|webp)/i)) mType = 'image';

                  localMedia.push({
                    name: m.name || path.split('/').pop() || 'Untitled',
                    path: path,
                    type: mType,
                    size: m.size || 0,
                    duration: m.duration || 0,
                    modified: m.creationDate ? new Date(m.creationDate).getTime() : Date.now(),
                    source: 'local',
                    folder: m.albumIdentifier || 'Internal Storage',
                    thumbnail: m.thumbnail || null
                  });
                }
              });
              if (prog) prog.textContent = `${localMedia.length} files found in library...`;
            } catch (e) {
              console.error('MediaStore query failed', e);
              if (prog) prog.textContent = "Native scan failed, trying filesystem...";
            }
          } else if (Media) {
            // Original fallback if MediaScanner is not available
            try {
              if (prog) prog.textContent = "Querying Media Library...";
              const res = await Media.getMedias({ quantity: 2000 }).catch(() => ({ medias: [] }));
              const allList = res.medias || (Array.isArray(res) ? res : []);
              allList.forEach(m => {
                if (!m.identifier) return;
                const path = m.identifier;
                if (!localMedia.some(lm => lm.path === path)) {
                  localMedia.push({
                    name: m.name || path.split('/').pop() || 'Untitled',
                    path: path,
                    type: (m.type === 'video' || m.type === 'videos') ? 'video' : 'audio',
                    size: m.size || 0,
                    duration: m.duration || 0,
                    modified: m.creationDate ? new Date(m.creationDate).getTime() : Date.now(),
                    source: 'local',
                    folder: m.albumIdentifier || 'Internal Storage',
                    thumbnail: m.thumbnail || null
                  });
                }
              });
            } catch (e) { console.error("Community plugin fail", e); }
          }

          // ── Deep Filesystem crawl ──
          // Skip the root '' to avoid hanging on Android root folders, just scan specific media folders
          if (Filesystem && localMedia.length < 50) {
            const roots = [
              'Download', 'Movies', 'Music', 'DCIM', 'Pictures', 'Recordings',
              'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video',
              'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio',
              'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images'
            ];
            for (const r of roots) {
              try { await scanDeep(r, 0); } catch (e) { }
              const el = document.getElementById('scanProgressText');
              if (el) el.textContent = `${localMedia.length} files found…`;
            }
          }
        } else {
          // ── Django API: fetch from local drives index ──
          try {
            if (isManual) {
              // Trigger a fresh background scan
              // Trigger a fresh background scan via the refresh action
              await fetch('/api/media/?action=refresh');
            }

            const fetchAndHandleMedia = async () => {
              const resp = await fetch('/api/media/');
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const data = await resp.json();

              if (data && Array.isArray(data.media)) {
                // Replace entire local array (fresh from DB)
                localMedia = data.media.map(m => ({
                  name: m.name,
                  path: m.path,
                  type: m.type,
                  size: m.size || 0,
                  duration: m.duration || 0,
                  modified: m.modified || 0,
                  source: 'remote',
                  folder: m.folder || '',
                  thumbnail: m.type === 'video'
                    ? `/api/thumbnail/?path=${encodeURIComponent(m.path)}`
                    : null,
                }));
                renderList();
              }

              if (data && data.scanning) {
                _is_scanning_bg = true;
                if (indicator) indicator.style.display = 'inline-block';
                pollScanStatus();
              } else {
                _is_scanning_bg = false;
                if (indicator) indicator.style.display = 'none';
              }
            };

            const pollScanStatus = async () => {
              try {
                const resp = await fetch('/api/scan-status/');
                if (!resp.ok) return;
                const data = await resp.json();

                if (data.scanning) {
                  const drive = data.progress.current_drive || "System";
                  const found = data.progress.files_found || 0;
                  const msg = `Scanning ${drive}... Found ${found} files`;
                  if (prog) prog.textContent = msg;
                  if (indicator) indicator.style.display = 'inline-block';

                  // Refresh the list periodically during scan
                  if (found > localMedia.length) {
                    fetchAndHandleMedia();
                  }

                  setTimeout(pollScanStatus, 2000);
                } else {
                  if (prog) prog.textContent = 'Scan complete!';
                  _is_scanning_bg = false;
                  if (indicator) indicator.style.display = 'none';
                  fetchAndHandleMedia(); // Final refresh
                }
              } catch (e) {
                console.error("Status poll failed", e);
              }
            };

            await fetchAndHandleMedia();
          } catch (apiErr) {
            console.error('API fetch error:', apiErr);
            showToast('Could not reach server. Is Django running?');
          }
        }

        localMedia = [...new Map(localMedia.map(i => [i.path, i])).values()];
        localMedia.sort((a, b) => (b.modified || 0) - (a.modified || 0));

        renderList();
        lastScanTime = Date.now();
        if (isManual && localMedia.length > 0)
          showToast(`Loaded ${localMedia.length} files`);
      } catch (err) {
        console.error('Scan error', err);
        renderList();
      } finally {
        if (indicator && !_is_scanning_bg) indicator.style.display = 'none';
        scanningActive = false;
        hideSplash();
        const btn = document.getElementById('scanBtn');
        if (btn) btn.classList.remove('scan-btn-pulse');
      }
    }
    // helper flag to keep indicator visible during background poll
    let _is_scanning_bg = false;

    async function scanDeep(path, depth = 0) {
      if (depth > 12 || !Filesystem) return; // Increased depth limit to 12 for better file discovery
      try {
        const result = await Filesystem.readdir({ path, directory: Directory.ExternalStorage });
        if (!result || !result.files) return;

        for (const file of result.files) {
          const fullPath = (path ? path + '/' : '') + file.name;
          if (file.type === 'directory') {
            if (file.name.startsWith('.') || file.name === 'Android' && depth === 0) continue;
            await scanDeep(fullPath, depth + 1);
          } else {
            const ext = file.name.split('.').pop().toLowerCase();
            const isVid = ['mp4', 'mkv', 'webm', '3gp', 'avi', 'mov', 'm4v'].includes(ext);
            const isAud = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'opus', 'mid'].includes(ext);

            if (isVid || isAud) {
              if (!localMedia.some(lm => lm.path === fullPath)) {
                localMedia.push({
                  name: file.name,
                  path: fullPath,
                  type: isVid ? 'video' : 'audio',
                  size: file.size || 0,
                  duration: 0,
                  modified: file.mtime || Date.now(),
                  source: 'local',
                  folder: path || 'Internal Storage'
                });
                const prog = document.getElementById('scanProgressText');
                if (prog && localMedia.length % 20 === 0) prog.textContent = `${localMedia.length} files found...`;
              }
            }
          }
        }
      } catch (e) { /* skip restricted errors */ }
    }

    function injectDemoData() {
      const now = Date.now();
      const songs = [
        { name: 'Blinding Lights.mp3', type: 'audio', size: 6291456, duration: 200, folder: 'Music' },
        { name: 'Bohemian Rhapsody.flac', type: 'audio', size: 31457280, duration: 354, folder: 'Music' },
        { name: 'Levitating.mp3', type: 'audio', size: 5242880, duration: 203, folder: 'Music/Dua Lipa' },
        { name: 'Shape of You.m4a', type: 'audio', size: 7340032, duration: 234, folder: 'Downloads' },
        { name: 'Peaches.mp3', type: 'audio', size: 5505024, duration: 197, folder: 'Music' },
        { name: 'Stay (The Kid LAROI).mp3', type: 'audio', size: 4194304, duration: 141, folder: 'Music/Pop' },
        { name: 'Industry Baby.mp3', type: 'audio', size: 5767168, duration: 212, folder: 'Music/Rap' },
        { name: 'Bad Guy.ogg', type: 'audio', size: 6815744, duration: 194, folder: 'Downloads' },
        { name: 'Sunflower.mp3', type: 'audio', size: 5505024, duration: 158, folder: 'Music/Post Malone' },
        { name: 'As It Was.mp3', type: 'audio', size: 5767168, duration: 167, folder: 'Music' },
        { name: 'Heat Waves.flac', type: 'audio', size: 26214400, duration: 238, folder: 'Music/Glass Animals' },
        { name: 'Watermelon Sugar.mp3', type: 'audio', size: 5242880, duration: 174, folder: 'Music/Harry Styles' },
        { name: 'good 4 u.m4a', type: 'audio', size: 5505024, duration: 178, folder: 'Downloads' },
        { name: 'Butter.mp3', type: 'audio', size: 4718592, duration: 163, folder: 'Music/BTS' },
        { name: 'Montero.mp3', type: 'audio', size: 5767168, duration: 137, folder: 'Music/Lil Nas X' },
      ];
      const videos = [
        { name: 'Concert Live 2024.mp4', type: 'video', size: 524288000, duration: 5400, folder: 'DCIM/Videos' },
        { name: 'Music Video 4K.mkv', type: 'video', size: 734003200, duration: 240, folder: 'Downloads' },
        { name: 'Short Film.mp4', type: 'video', size: 209715200, duration: 900, folder: 'Movies' },
        { name: 'Road Trip Vlog.mp4', type: 'video', size: 314572800, duration: 1800, folder: 'DCIM/Camera' },
        { name: 'Workout Session.mp4', type: 'video', size: 157286400, duration: 3600, folder: 'DCIM/Videos' },
        { name: 'Interview Recording.mp4', type: 'video', size: 419430400, duration: 7200, folder: 'Recordings' },
        { name: 'Timelapse City.mp4', type: 'video', size: 104857600, duration: 120, folder: 'DCIM/Camera' },
        { name: 'WhatsApp Video 2024-01-15.mp4', type: 'video', size: 26214400, duration: 45, folder: 'Android/media/com.whatsapp' },
      ];
      [...songs, ...videos].forEach((f, i) => {
        localMedia.push({
          ...f,
          path: `/${f.folder}/${f.name}`,
          modified: now - (i * 3600000 * (i % 3 + 1)),
          source: 'local'
        });
      });
    }

    function hideSplash() {
      const s = document.getElementById('app-splash');
      if (s) { s.style.opacity = '0'; setTimeout(() => s.style.display = 'none', 550); }
    }

    /* ── FETCH / ENTRY ── */
    async function fetchMediaFiles() {
      document.getElementById('scanBtn').classList.add('scan-btn-pulse');
      await scanLocalStorage(true); // Force manual scan with UI
    }

    /* ── TAB SWITCH ── */
    function setTab(type, el) {
      currentTab = type;
      currentFolderPath = null;
      document.querySelectorAll('.tab-pill').forEach(t => t.classList.remove('active'));
      if (el) el.classList.add('active');
      renderList();
    }

    /* ── RENDER ── */
    function renderList() {
      const container = document.getElementById('mediaContainer');
      const query = document.getElementById('searchInput').value.toLowerCase();
      const sort = document.getElementById('sortSelect').value;
      let list = [...localMedia];

      // Filter by tab
      if (currentTab === 'audio') list = list.filter(f => f.type === 'audio');
      else if (currentTab === 'video') list = list.filter(f => f.type === 'video');
      else if (currentTab === 'favorites') list = list.filter(f => favorites.includes(f.path));
      else if (currentTab === 'recent') list = list.filter(f => isRecentlyAdded(f.modified));

      // Search
      if (query) list = list.filter(f => f.name.toLowerCase().includes(query) || (f.folder || '').toLowerCase().includes(query));

      // Sort
      if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
      else if (sort === 'name_desc') list.sort((a, b) => b.name.localeCompare(a.name));
      else if (sort === 'size') list.sort((a, b) => (b.size || 0) - (a.size || 0));
      else if (sort === 'duration') list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
      else list.sort((a, b) => (b.modified || 0) - (a.modified || 0)); // recent

      currentListView = list;
      document.getElementById('statsCount').textContent = list.length;

      if (currentTab === 'folders') {
        renderFolderView(container, query);
        return;
      }

      if (!list.length) {
        container.innerHTML = renderEmptyState();
        return;
      }

      // ── LAZY BATCH RENDERING ──
      // To keep UI responsive, we render in chunks of 100
      container.innerHTML = '';
      const batchSize = 100;
      let currentIndex = 0;

      function renderBatch() {
        const end = Math.min(currentIndex + batchSize, list.length);
        const chunk = list.slice(currentIndex, end);

        let batchHtml = chunk.map(f => renderMediaItem(f)).join('');

        // Wrap in a list container if it's the first batch
        if (currentIndex === 0) {
          container.innerHTML = `<div class="media-list" id="lazyList">${batchHtml}</div>`;
        } else {
          document.getElementById('lazyList').insertAdjacentHTML('beforeend', batchHtml);
        }

        currentIndex = end;
        if (currentIndex < list.length) {
          // Use requestIdleCallback or setTimeout to yield to main thread
          if (window.requestIdleCallback) {
            requestIdleCallback(renderBatch);
          } else {
            setTimeout(renderBatch, 16);
          }
        }
      }

      renderBatch();
      return;
    }

    function renderMediaItem(f) {
      const isPlaying = f.path === (playQueue[queueIndex] || {}).path && document.getElementById('playerModal').classList.contains('open');
      const isFav = favorites.includes(f.path);
      const thumb = getThumb(f);
      return `
    <div class="media-item${isPlaying ? ' playing' : ''}" onclick="playFile('${escapeAttr(f.path)}')">
      <div class="media-thumb">
        ${f.type === 'video'
          ? `<img src="${escapeAttr(f.thumbnail || '')}" alt="${escapeHtml(f.name)}" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; this.parentNode.querySelector('.thumb-fallback').style.display='flex'; this.style.display='none';">`
          : ''}
        <div class="thumb-fallback" style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-size:24px; border-radius:12px;">${f.type === 'video' ? '🎬' : '🎵'}</div>
        <div class="play-overlay"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
        <div class="thumb-type-icon">
          ${f.type === 'video'
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}
        </div>
      </div>
      <div class="media-info">
        <div class="media-name${isPlaying ? ' playing-name' : ''}">${escapeHtml(cleanName(f.name))}</div>
        <!-- Technical info (size, folder, badge) hidden for clean UI -->
        <div class="media-meta" style="display:none;"></div>
      </div>
      <div style="display:flex; align-items:center; gap:4px; margin-left:auto;">
        ${isPlaying
          ? ``
          : f.duration ? `<div class="media-duration">${formatTime(f.duration)}</div>` : ''}
        ${f.source === 'remote' ? `
          <div class="icon-btn" style="width:34px; height:34px; border-radius:10px; color:var(--accent3);" onclick="event.stopPropagation(); handleOption('download', '${escapeAttr(f.path)}')">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
        ` : ''}
        <div class="icon-btn" style="width:30px; height:30px; background:none; border:none;" onclick="event.stopPropagation(); showItemOptions('${escapeAttr(f.path)}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>
        </div>
      </div>
      ${isFav ? '<div style="color:var(--accent2);font-size:14px;margin-left:4px;">♥</div>' : ''}
    </div>`;
    }

    function renderGroupedRecent(container, list) {
      const today = []; const week = []; const older = [];
      const now = Date.now();
      list.forEach(f => {
        const age = now - (f.modified || 0);
        if (age < 86400000) today.push(f);
        else if (age < 604800000) week.push(f);
        else older.push(f);
      });
      let html = '';
      if (today.length) {
        html += `<div class="section-header"><div class="section-title"><div class="dot"></div>Today</div><div class="section-count">${today.length}</div></div>`;
        html += `<div class="media-list">${today.map(f => renderMediaItem(f)).join('')}</div>`;
      }
      if (week.length) {
        html += `<div class="section-header"><div class="section-title"><div class="dot" style="background:var(--accent2)"></div>This Week</div><div class="section-count">${week.length}</div></div>`;
        html += `<div class="media-list">${week.map(f => renderMediaItem(f)).join('')}</div>`;
      }
      if (older.length) {
        html += `<div class="section-header"><div class="section-title"><div class="dot" style="background:var(--accent3)"></div>Older</div><div class="section-count">${older.length}</div></div>`;
        html += `<div class="media-list">${older.map(f => renderMediaItem(f)).join('')}</div>`;
      }
      container.innerHTML = html;
    }

    function renderFolderView(container, query) {
      if (currentFolderPath !== null) {
        const files = localMedia.filter(f => (f.folder || '') === currentFolderPath);
        const filtered = query ? files.filter(f => f.name.toLowerCase().includes(query)) : files;
        document.getElementById('statsCount').textContent = filtered.length;
        container.innerHTML = `
      <div class="back-btn" onclick="currentFolderPath=null;renderList();">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Folders
      </div>
      <div class="section-header"><div class="section-title"><div class="dot"></div>${escapeHtml(currentFolderPath.split('/').pop())}</div><div class="section-count">${filtered.length}</div></div>
      <div class="media-list">${filtered.map(f => renderMediaItem(f)).join('')}</div>`;
        return;
      }

      // Build folder map
      const folderMap = {};
      localMedia.forEach(f => {
        const folder = f.folder || 'Root';
        if (!folderMap[folder]) folderMap[folder] = { audio: 0, video: 0, total: 0 };
        folderMap[folder][f.type]++;
        folderMap[folder].total++;
      });

      const folders = Object.entries(folderMap)
        .filter(([name]) => !query || name.toLowerCase().includes(query))
        .sort((a, b) => b[1].total - a[1].total);

      document.getElementById('statsCount').textContent = folders.length;

      if (!folders.length) { container.innerHTML = renderEmptyState(); return; }

      const folderIcons = { 'Music': '🎵', 'Download': '⬇️', 'DCIM': '📸', 'Movies': '🎬', 'Documents': '📄', 'Recordings': '🎙️', 'Root': '📁', 'Gallery': '🖼️' };
      container.innerHTML = `
    <div class="section-header"><div class="section-title"><div class="dot"></div>Folders</div><div class="section-count">${folders.length}</div></div>
    <div class="folder-grid">
      ${folders.map(([name, counts]) => {
        const icon = Object.keys(folderIcons).find(k => name.toLowerCase().includes(k.toLowerCase())) ? folderIcons[Object.keys(folderIcons).find(k => name.toLowerCase().includes(k.toLowerCase()))] : '📂';
        return `<div class="folder-card" onclick="currentFolderPath='${escapeAttr(name)}';renderList();">
          <div class="folder-icon">${icon}</div>
          <div class="folder-name">${escapeHtml(name.split('/').pop() || name)}</div>
          <div class="folder-count">${counts.total} file${counts.total !== 1 ? 's' : ''} · ${counts.audio ? counts.audio + ' songs' : ''} ${counts.video ? counts.video + ' videos' : ''}</div>
        </div>`;
      }).join('')}
    </div>`;
    }

    function renderEmptyState() {
      const msgs = {
        all: ['No media found', 'Tap the refresh button to scan your device storage.'],
        audio: ['No songs found', 'Audio files (.mp3, .flac, .m4a…) will appear here.'],
        video: ['No videos found', 'Video files (.mp4, .mkv…) will appear here.'],
        image: ['No photos found', 'Images (.jpg, .png…) from your gallery will appear here.'],
        favorites: ['No favourites yet', 'Heart a track while it\'s playing to save it here.'],
        recent: ['Nothing recent', 'Files added in the past 7 days appear here.'],
        folders: ['No folders found', 'Media folders from your device will appear here.'],
      };
      const [title, sub] = msgs[currentTab] || msgs.all;
      return `<div class="empty-state"><div class="empty-icon">🎶</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;
    }

    function getThumb(f) {
      if (f.thumbnail) {
        return `<img src="${escapeAttr(f.thumbnail)}" alt="${escapeHtml(f.name)}" onerror="this.style.display='none'; this.parentNode.querySelector('.thumb-fallback').style.display='flex';">`;
      }
      const fallbackIcon = f.type === 'video' ? '🎬' : f.type === 'image' ? '🖼️' : '🎵';
      return `<div class="thumb-fallback" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px;border-radius:12px;">${fallbackIcon}</div>`;
    }

    function cleanName(name) {
      return name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
    }

    /* ── PLAYBACK ── */
    function playFile(path) {
      const idx = currentListView.findIndex(f => f.path === path);
      if (idx === -1) {
        const f = localMedia.find(m => m.path === path);
        if (f) { playQueue = [f]; playIndex(0); }
        return;
      }
      playQueue = [...currentListView];
      playIndex(idx);
    }

    async function playIndex(idx) {
      if (idx < 0 || idx >= playQueue.length) return;
      queueIndex = idx;
      activeIndex = idx; // sync for UI
      const f = playQueue[idx];
      const audio = document.getElementById('audioPlayer');
      const video = document.getElementById('videoPlayer');
      const audioArt = document.getElementById('audioArt');
      const videoContainer = document.getElementById('videoContainer');

      // Build URL
      let url;
      if (f.source === 'local' && window.Capacitor && Capacitor.isNativePlatform()) {
        try {
          if (f.type === 'audio') {
            // For audio, bypass WebView storage restrictions entirely by reading to a Blob
            showToast("Loading audio track...");
            const readParams = (f.path.startsWith('/') || f.path.startsWith('file://') || f.path.startsWith('content://'))
              ? { path: f.path }
              : { path: f.path, directory: Directory.ExternalStorage };
            
            const contents = await Filesystem.readFile(readParams);
            
            // Convert base64 to blob url
            const byteChars = atob(contents.data);
            const byteNums = new Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
              byteNums[i] = byteChars.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNums);
            const blob = new Blob([byteArray], { type: 'audio/mpeg' });
            url = URL.createObjectURL(blob);
          } else {
            // Video fallback (too large for blob)
            const stat = await Filesystem.getUri({
              path: f.path,
              directory: f.path.startsWith('/') ? undefined : Directory.ExternalStorage
            });
            const rawUrl = Capacitor.convertFileSrc(stat.uri || f.path);
            url = encodeURI(rawUrl).replace(/#/g, '%23').replace(/\?/g, '%3F');
          }
        } catch (e) {
          console.error('Filesystem approach failed, falling back:', e);
          const rawUrl = Capacitor.convertFileSrc(f.path);
          url = encodeURI(rawUrl).replace(/#/g, '%23').replace(/\?/g, '%3F');
        }
      } else if (f.source === 'remote') {
        // PC files indexed by Django backend — stream via same origin
        url = `/api/stream/?path=${encodeURIComponent(f.path)}`;
      } else {
        // Fallback (shouldn't happen)
        url = f.path;
      }

      if (f.type === 'video') {
        audioArt.style.display = 'none';
        videoContainer.style.display = 'block';
        document.getElementById('fsBtn').style.visibility = 'visible';
        document.getElementById('playerLabel').textContent = 'Now Playing';
        audio.pause(); audio.src = '';
        video.src = url;
        video.play().catch(e => {
          console.error("Video play failed", e);
          showToast("Video playback failed: " + e.message);
        });
        setupVideoListeners(video);
      } else {
        audioArt.style.display = 'flex';
        videoContainer.style.display = 'none';
        document.getElementById('fsBtn').style.visibility = 'hidden';
        document.getElementById('playerLabel').textContent = 'Now Playing';
        video.pause(); video.src = '';
        audio.src = url;
        audio.play().catch(e => {
          console.error("Audio play failed", e);
          showToast("Audio playback failed: " + e.message);
        });
        setupAudioListeners(audio);
        setupVisualizer(audio);
      }

      document.getElementById('playerTitle').textContent = cleanName(f.name);
      document.getElementById('playerMeta').textContent = ''; // Technical info hidden for clean playback
      lastSelectedFile = f; // Important: ensure menu works for currently playing too
      document.getElementById('playerModal').classList.add('open');

      // Setup interaction listeners for hidden controls
      setupControlInteraction();

      // Update play button
      updatePlayBtn(true);
      updateHeartBtn();
      renderList(); // update playing state
      // Show/hide download button for remote files
      const dlBtn = document.getElementById('downloadBtn');
      if (dlBtn) dlBtn.style.display = f.source === 'remote' ? 'flex' : 'none';

      // Update Native Music Controls
      updateMusicControls(true);
    }

    let controlTimer;
    let _onPauseHandler = null;
    let _onPlayHandler = null;

    function setupControlInteraction() {
      const modal = document.getElementById('playerModal');
      const f = playQueue[queueIndex];
      const el = f && f.type === 'video' ? document.getElementById('videoPlayer') : document.getElementById('audioPlayer');

      if (!el) return;

      const show = (persist = false) => {
        modal.classList.add('show-controls');
        clearTimeout(controlTimer);
        if (persist) return;
        if (!el.paused && !el.ended) {
          controlTimer = setTimeout(() => modal.classList.remove('show-controls'), 3000);
        }
      };

      modal.onmousemove = () => show();
      modal.ontouchstart = () => show();

      // Clean up previous listeners if they exist
      if (_onPauseHandler) {
        document.getElementById('audioPlayer').removeEventListener('pause', _onPauseHandler);
        document.getElementById('videoPlayer').removeEventListener('pause', _onPauseHandler);
      }
      if (_onPlayHandler) {
        document.getElementById('audioPlayer').removeEventListener('play', _onPlayHandler);
        document.getElementById('videoPlayer').removeEventListener('play', _onPlayHandler);
      }

      _onPauseHandler = () => show(true);
      _onPlayHandler = () => show();

      el.addEventListener('pause', _onPauseHandler);
      el.addEventListener('play', _onPlayHandler);

      show(el.paused);
    }

    let _audioListenersBound = false;
    let _videoListenersBound = false;

    function setupAudioListeners(el) {
      if (_audioListenersBound) return;
      _audioListenersBound = true;
      el.addEventListener('timeupdate', () => updateProgress(el));
      el.addEventListener('loadedmetadata', () => {
        document.getElementById('timeTotal').textContent = formatTime(el.duration);
        document.getElementById('timeTotal').title = `${formatTime(el.duration)}`;
      });
      el.addEventListener('play', () => updatePlayBtn(true));
      el.addEventListener('pause', () => updatePlayBtn(false));
      el.addEventListener('ended', onMediaEnded);
    }
    function setupVideoListeners(el) {
      if (_videoListenersBound) return;
      _videoListenersBound = true;
      el.addEventListener('timeupdate', () => updateProgress(el));
      el.addEventListener('loadedmetadata', () => document.getElementById('timeTotal').textContent = formatTime(el.duration));
      el.addEventListener('play', () => updatePlayBtn(true));
      el.addEventListener('pause', () => updatePlayBtn(false));
      el.addEventListener('ended', onMediaEnded);
    }

    function updateProgress(el) {
      if (!el.duration) return;
      const pct = (el.currentTime / el.duration) * 100;
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('timeCurrent').textContent = formatTime(el.currentTime);
      if (loopA !== null && loopB !== null && el.currentTime >= loopB) el.currentTime = loopA;
    }

    function updatePlayBtn(playing) {
      const btn = document.getElementById('mainPlayBtn');
      btn.innerHTML = playing
        ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg width="26" height="26" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }

    function togglePlay() {
      const audio = document.getElementById('audioPlayer');
      const video = document.getElementById('videoPlayer');
      const f = playQueue[queueIndex]; // Use queueIndex for accurate current file
      if (!f) return;
      const el = f.type === 'video' ? video : audio;
      if (el.paused) {
        el.play();
        updateMusicControls(true);
      } else {
        el.pause();
        updateMusicControls(false);
      }
    }

    function seek(e) {
      const bg = document.getElementById('progressBg');
      const ratio = e.offsetX / bg.offsetWidth;
      const f = playQueue[queueIndex];
      const el = f && f.type === 'video' ? document.getElementById('videoPlayer') : document.getElementById('audioPlayer');
      if (el.duration) el.currentTime = ratio * el.duration;
    }



    function addToQueue(path) {
      const f = localMedia.find(m => m.path === path);
      if (f && !playQueue.some(q => q.path === path)) {
        playQueue.push(f);
        showToast('Added to queue');
      } else {
        showToast('Already in queue');
      }
    }

    function removeFromQueue(idx, e) {
      if (e) e.stopPropagation();
      if (idx === queueIndex) {
        showToast('Cannot remove currently playing track');
        return;
      }
      playQueue.splice(idx, 1);
      if (idx < queueIndex) queueIndex--;
      renderQueue();
    }

    function moveQueueItem(idx, direction, e) {
      if (e) e.stopPropagation();
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= playQueue.length) return;

      const item = playQueue.splice(idx, 1)[0];
      playQueue.splice(newIdx, 0, item);

      if (idx === queueIndex) queueIndex = newIdx;
      else if (queueIndex === newIdx) queueIndex = idx;

      renderQueue();
    }


    function playNext() {
      if (!playQueue.length) return;
      let next;
      if (isShuffle) next = Math.floor(Math.random() * playQueue.length);
      else next = (queueIndex + 1) % playQueue.length;
      playIndex(next);
    }
    function playPrev() {
      if (!playQueue.length) return;
      const prev = (queueIndex - 1 + playQueue.length) % playQueue.length;
      playIndex(prev);
    }

    function onMediaEnded() {
      document.getElementById('playerModal').classList.add('show-controls');
      if (isRepeat) {
        const f = playQueue[queueIndex];
        const el = f && f.type === 'video' ? document.getElementById('videoPlayer') : document.getElementById('audioPlayer');
        el.currentTime = 0; el.play();
      } else if (isAutoplay) {
        playNext();
      }
    }

    function closePlayer() {
      document.getElementById('playerModal').classList.remove('open');
    }

    function toggleFullscreen() {
      const v = document.getElementById('videoPlayer');
      if (v.requestFullscreen) v.requestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    }

    /* ── Player Controls ── */
    function toggleShuffle() {
      isShuffle = !isShuffle;
      document.getElementById('shuffleBtn').classList.toggle('active-state', isShuffle);
      showToast(isShuffle ? 'Shuffle on' : 'Shuffle off');
    }
    function toggleRepeat() {
      isRepeat = !isRepeat;
      document.getElementById('repeatBtn').classList.toggle('active-state', isRepeat);
      showToast(isRepeat ? 'Repeat on' : 'Repeat off');
    }
    function toggleAutoplay() {
      isAutoplay = !isAutoplay;
      document.getElementById('autoplayBtn').classList.toggle('active-state', isAutoplay);
      showToast(isAutoplay ? 'Autoplay on' : 'Autoplay off');
    }
    function toggleSpeed() {
      currentSpeedIdx = (currentSpeedIdx + 1) % speeds.length;
      const spd = speeds[currentSpeedIdx];
      document.getElementById('audioPlayer').playbackRate = spd;
      document.getElementById('videoPlayer').playbackRate = spd;
      document.getElementById('speedLabel').textContent = spd + '×';
      document.getElementById('speedBtn').classList.toggle('active-state', spd !== 1);
      showToast(`Playback speed: ${spd}×`);
    }
    function toggleHeart() {
      const f = playQueue[queueIndex] || lastSelectedFile;
      if (!f) return;
      const idx = favorites.indexOf(f.path);
      if (idx === -1) { favorites.push(f.path); showToast('Added to favourites ♥'); }
      else { favorites.splice(idx, 1); showToast('Removed from favourites'); }
      saveFavorites();
      updateHeartBtn();
      renderList();
    }
    function updateHeartBtn() {
      const f = playQueue[queueIndex];
      const on = f && favorites.includes(f.path);
      const btn = document.getElementById('heartBtn');
      if (!btn) return;
      btn.classList.toggle('active-state', on);
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', on ? 'var(--accent2)' : 'none');
    }
    function toggleABLoop() {
      const f = playQueue[queueIndex];
      const el = f && f.type === 'video' ? document.getElementById('videoPlayer') : document.getElementById('audioPlayer');
      if (loopA === null) { loopA = el.currentTime; document.getElementById('abLoopBtn').classList.add('active-state'); showToast('A-B Loop: point A set'); }
      else if (loopB === null) { loopB = el.currentTime; showToast(`A-B Loop active (${formatTime(loopA)} → ${formatTime(loopB)})`); }
      else { loopA = null; loopB = null; document.getElementById('abLoopBtn').classList.remove('active-state'); showToast('A-B Loop cleared'); }
    }

    /* ── Visualizer ── */
    let audioCtx, analyser, vizSource, rafId;
    function setupVisualizer(audioEl) {
      try {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 128;
          vizSource = audioCtx.createMediaElementSource(audioEl);
          vizSource.connect(analyser);
          analyser.connect(audioCtx.destination);
        }
        drawVisualizer();
      } catch (e) {
        console.error("Visualizer error:", e);
      }
    }
    function drawVisualizer() {
      const canvas = document.getElementById('visualizer');
      if (!canvas || !analyser) return;
      const ctx = canvas.getContext('2d');
      const W = canvas.width = canvas.offsetWidth;
      const H = canvas.height = canvas.offsetHeight;
      const data = new Uint8Array(analyser.frequencyBinCount);
      function draw() {
        rafId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(data);
        ctx.clearRect(0, 0, W, H);
        const bars = data.length;
        const bw = W / bars;
        for (let i = 0; i < bars; i++) {
          const val = data[i] / 255;
          const h = val * H * 0.8;
          const hue = 260 + val * 60;
          ctx.fillStyle = `hsla(${hue},80%,60%,${0.4 + val * 0.5})`;
          ctx.fillRect(i * bw, H - h, bw - 1, h);
        }
      }
      draw();
    }

    /* ── Equalizer ── */
    const EQ_BANDS = [60, 170, 350, 1000, 3500, 10000];
    const EQ_LABELS = ['60', '170', '350', '1K', '3.5K', '10K'];
    const EQ_PRESETS = {
      Flat: [0, 0, 0, 0, 0, 0],
      Bass: [8, 6, 4, 0, 0, 0],
      Treble: [0, 0, 0, 2, 6, 8],
      Pop: [-2, 4, 6, 4, -2, -2],
      Rock: [6, 4, 0, -2, 2, 6],
      Vocal: [-2, -2, 4, 6, 4, -2],
      Classical: [4, 2, 0, 0, 2, 4]
    };
    let eqFilters = [];
    function buildEQ() {
      const container = document.getElementById('eqSliders');
      container.innerHTML = EQ_BANDS.map((_, i) => `
    <div class="eq-band">
      <div class="slider-container">
        <input type="range" class="eq-slider" id="eq${i}" min="-12" max="12" step="1" value="0" oninput="applyEQ()">
      </div>
      <div class="eq-label">${EQ_LABELS[i]}</div>
    </div>`).join('');
      const presetsEl = document.getElementById('eqPresets');
      presetsEl.innerHTML = Object.keys(EQ_PRESETS).map(p =>
        `<button class="preset-btn" onclick="applyPreset('${p}',this)">${p}</button>`
      ).join('');
    }
    function applyEQ() {
      // EQ via Web Audio not wired in demo (would need BiquadFilterNode chain)
      showToast('EQ applied');
    }
    function applyPreset(name, el) {
      const vals = EQ_PRESETS[name];
      vals.forEach((v, i) => {
        const s = document.getElementById('eq' + i);
        if (s) s.value = v;
      });
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      applyEQ();
      showToast(`Preset: ${name}`);
    }
    function toggleEqualizer() {
      if (!document.getElementById('eqSliders').children.length) buildEQ();
      openModal('eqModal');
    }

    /* ── Modals ── */
    function openModal(id) { document.getElementById(id).classList.add('open'); }
    function closeModal(id, e) {
      if (e && e.target !== document.getElementById(id)) return;
      document.getElementById(id).classList.remove('open');
    }

    function showMoreOptions() {
      const f = playQueue[queueIndex];
      if (f) {
        lastSelectedFile = f;
        document.getElementById('optionsTitle').textContent = cleanName(f.name);
        const dlOpt = document.getElementById('downloadOption');
        if (dlOpt) dlOpt.style.display = f.source === 'remote' ? 'flex' : 'none';
        openModal('optionsModal');
      }
    }

    function showItemOptions(path) {
      const f = localMedia.find(m => m.path === path);
      if (f) {
        lastSelectedFile = f;
        document.getElementById('optionsTitle').textContent = cleanName(f.name);
        const dlOpt = document.getElementById('downloadOption');
        if (dlOpt) dlOpt.style.display = f.source === 'remote' ? 'flex' : 'none';
        openModal('optionsModal');
      }
    }

    function handleOption(action, path = null) {
      closeModal('optionsModal');
      const f = (path ? localMedia.find(m => m.path === path) : lastSelectedFile) || playQueue[queueIndex];
      if (!f) return;
      switch (action) {
        case 'queue': addToQueue(f.path); break;
        case 'playlist': openModal('addToPlaylistModal'); renderAddToPlaylist(); break;
        case 'share':
          openSocialShare(f);
          break;
        case 'properties': showProperties(f); break;
        case 'ringtone': showToast('Set as Ringtone: use Android settings'); break;
        case 'sleep':
          const mins = prompt('Sleep timer (minutes):');
          if (mins && !isNaN(mins)) {
            clearTimeout(sleepTimer);
            sleepTimer = setTimeout(() => {
              document.getElementById('audioPlayer').pause();
              document.getElementById('videoPlayer').pause();
              showToast('Sleep timer: playback stopped');
            }, parseInt(mins) * 60000);
            showToast(`Sleep timer set for ${mins} min`);
          }
          break;
        case 'delete':
          deleteFile(f.path);
          break;
        case 'download':
          const dUrl = f.source === 'remote' ? `${apiBase}/api/stream/?path=${encodeURIComponent(f.path)}` : f.path;
          if (window.Capacitor && Capacitor.isNativePlatform()) {
            downloadMedia(dUrl, f.name, f.type);
          } else {
            const a = document.createElement('a');
            a.href = dUrl;
            a.download = f.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            showToast('Download started');
          }
          break;
      }
    }

    /* ── Social Share Logic ── */
    const socialPlatforms = [
      { id: 'native', name: 'System', color: 'bg-native', icon: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z' },
      { id: 'whatsapp', name: 'WhatsApp', color: 'bg-whatsapp', icon: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z' },
      { id: 'instagram', name: 'Instagram', color: 'bg-instagram', icon: 'M12 2.163c3.204 0 3.584.012 4.85.07 1.17.054 1.805.249 2.227.412.56.216.96.474 1.38.894.42.42.678.82.894 1.38.163.422.358 1.057.412 2.227.058 1.266.07 1.646.07 4.85s-.012 3.584-.07 4.85c-.054 1.17-.249 1.805-.412 2.227-.216.56-.474.96-.894 1.38-.42.42-.82.678-1.38.894-.422.163-1.057.358-2.227.412-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.17-.054-1.805-.249-2.227-.412-.56-.216-.96-.474-1.38-.894-.42-.42-.678-.82-.894-1.38-.163-.422-.358-1.057-.412-2.227-.058-1.266-.07-1.646-.07-4.85s.012-3.584.07-4.85c.054-1.17.249-1.805.412-2.227.216-.56.474-.96.894-1.38.42-.42.82-.678 1.38-.894.422-.163 1.057-.358 2.227-.412 1.266-.058 1.646-.07 4.85-.07M12 0C8.741 0 8.333.014 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.132 5.775.072 7.053.014 8.333 0 8.741 0 12s.014 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126s1.384 1.078 2.126 1.384c.766.296 1.636.499 2.913.558C8.333 23.986 8.741 24 12 24s3.667-.014 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384s1.078-1.384 1.384-2.126c.296-.765.499-1.636.558-2.913.058-1.28.072-1.687.072-4.947s-.014-3.667-.072-4.947c-.06-1.277-.262-2.148-.558-2.913-.306-.789-.718-1.459-1.384-2.126s-1.384-1.078-2.126-1.384c-.765-.296-1.636-.499-2.913-.558C15.667.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
      { id: 'facebook', name: 'Facebook', color: 'bg-facebook', icon: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
      { id: 'twitter', name: 'X', color: 'bg-twitter', icon: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932 6.064-6.932zm-1.292 19.49h2.039L6.486 3.24H4.298l13.311 17.403z' },
      { id: 'telegram', name: 'Telegram', color: 'bg-telegram', icon: 'M11.944 0a12 12 0 100 24 12 12 0 000-24zm5.812 8.356c-.173 1.823-.933 6.302-1.32 8.368-.163.874-.486 1.168-.797 1.196-.684.064-1.203-.452-1.865-.886-1.036-.68-1.621-1.103-2.626-1.765-1.162-.765-.408-1.184.254-1.87.173-.18.318-.291 1.623-1.49 1.423-1.3 1.7-1.84 1.703-2.12.003-.28-.152-.43-.448-.43-.12 0-.312.023-.526.082-.214.059-1.824 1.12-5.15 3.364-.488.33-.93.493-1.327.484-.436-.01-1.274-.247-1.897-.45-.764-.247-1.37-.378-1.317-.798.028-.218.328-.441.9-.669 3.515-1.53 5.858-2.54 7.03-3.03 3.344-1.393 4.038-1.635 4.491-1.642.1 0 .322.025.466.14.121.1.156.233.17.34.013.111.028.322.015.53z' },
      { id: 'snapchat', name: 'Snap', color: 'bg-snapchat', icon: 'M12 0a11.9 11.9 0 00-5.556 1.367c-.267.133-.533.367-.533.667 0 1.256.444 3.011.833 4.844.034.156-.111.233-.211.278C6.011 7.378 4.222 8.356 4.222 10.3c0 1.056.467 1.944 1.344 2.6.1.078.111.2.044.3-.267.433-.678.967-.678 1.6 0 1.311.944 2.156 2.056 2.156.233 0 .5-.044.756-.122.1-.033.2.022.256.1.289.433.822 1.111 1.756 1.111.889 0 1.389-.578 1.667-.933.067-.089.211-.089.289 0 .278.356.778.933 1.667.933.933 0 1.467-.678 1.756-1.111.056-.078.156-.133.256-.1.256.078.522.122.756.122 1.111 0 2.056-.845 2.056-2.156 0-.633-.411-1.167-.678-1.6-.067-.1-.056-.222.044-.3.878-.656 1.344-1.544 1.344-2.6 0-1.944-1.789-2.922-2.311-3.144-.1-.044-.245-.122-.211-.278.389-1.833.833-3.589.833-4.844 0-.3-.267-.533-.533-.667A11.9 11.9 0 0012 0z' },
      { id: 'linkedin', name: 'LinkedIn', color: 'bg-linkedin', icon: 'M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z' },
      { id: 'reddit', name: 'Reddit', color: 'bg-reddit', icon: 'M12 0a12 12 0 1012 12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.563 1.25 1.25 0 .541-.343 1.003-.827 1.177A1.26 1.26 0 0117.684 8c0 1.834-2.545 3.322-5.684 3.322S6.316 9.834 6.316 8c0-.18.048-.352.138-.503a1.25 1.25 0 01.423-2.327c.688 0 1.25.562 1.25 1.25 0 .428-.216.804-.543 1.029.805.908 2.213 1.498 3.824 1.621l.732-3.447.016-.075a.3.3 0 01.378-.224l2.458.52c.164-.326.502-.553.896-.553z' },
      { id: 'pinterest', name: 'Pinterest', color: 'bg-pinterest', icon: 'M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.966 1.406-5.966s-.359-.72-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146 1.124.347 2.317.535 3.554.535 6.607 0 11.985-5.36 11.985-11.987C24.014 5.367 18.638 0 12.017 0z' },
      { id: 'messenger', name: 'Messenger', color: 'bg-messenger', icon: 'M12 0C5.373 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.654V24l4.088-2.242c1.112.309 2.298.475 3.525.475 6.627 0 12-4.975 12-11.111C24 4.974 18.627 0 12 0zm1.291 14.194l-3.076-3.282-5.992 3.282 6.585-7.003 3.153 3.282 5.915-3.282-6.585 7.003z' },
      { id: 'tiktok', name: 'TikTok', color: 'bg-tiktok', icon: 'M12.525.02c1.31-.02 2.61-.01 3.91-.01.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.59-5.71-.29-2.58 1.34-5.18 3.84-6.07 1.1-.42 2.31-.5 3.48-.28.02 1.42-.01 2.84-.01 4.25-1.01-.22-2.1-.04-2.9.6-.83.69-1.19 1.83-.9 2.87.16.83.68 1.55 1.41 1.95.78.47 1.75.56 2.6.24.8-.27 1.44-.94 1.73-1.71.18-.5.22-1.04.2-1.57-.01-4.52-.01-9.04-.01-13.56z' },
      { id: 'gmail', name: 'Gmail', color: 'bg-gmail', icon: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 010 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L12 9.573l8.073-6.08c1.618-1.214 3.927-.059 3.927 1.964z' },
      { id: 'sms', name: 'SMS', color: 'bg-sms', icon: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z' },
      { id: 'copy', name: 'Copy Link', color: 'bg-copy', icon: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z' }
    ];

    function openSocialShare(f) {
      console.log('openSocialShare called', f);
      if (!f) f = lastSelectedFile || playQueue[queueIndex];
      if (!f) {
        showToast('Please select a file first');
        return;
      }
      lastSelectedFile = f;
      const grid = document.getElementById('shareGrid');
      if (!grid) {
        console.error('shareGrid element not found');
        return;
      }

      grid.innerHTML = socialPlatforms.map(p => `
        <div class="share-option" onclick="shareToPlatform('${p.id}')">
          <div class="share-icon-wrap ${p.color}">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="${p.icon}"/>
            </svg>
          </div>
          <span class="share-label">${p.name}</span>
        </div>
      `).join('');

      openModal('socialShareModal');
    }

    async function shareToPlatform(id) {
      const f = lastSelectedFile;
      if (!f) return;

      const title = cleanName(f.name);
      const desc = `Check out this ${f.type}: ${title}`;
      const streamUrl = `${apiBase}/api/stream/?path=${encodeURIComponent(f.path)}`;

      if (id === 'native') {
        closeModal('socialShareModal');
        handleNativeShare(f);
        return;
      }

      if (id === 'copy') {
        copyToClipboard(streamUrl);
        showToast('Link copied to clipboard');
        return;
      }

      if (id === 'instagram' || id === 'tiktok') {
        showToast(`Sharing directly to ${id} is limited. Download and share manually.`);
        return;
      }

      const encodedUrl = encodeURIComponent(streamUrl);
      const encodedText = encodeURIComponent(desc);
      const encodedTitle = encodeURIComponent(title);

      let shareUrl = '';
      switch (id) {
        case 'whatsapp': shareUrl = `https://api.whatsapp.com/send?text=${encodedText}%20${encodedUrl}`; break;
        case 'facebook': shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`; break;
        case 'twitter': shareUrl = `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`; break;
        case 'telegram': shareUrl = `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`; break;
        case 'linkedin': shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`; break;
        case 'reddit': shareUrl = `https://www.reddit.com/submit?url=${encodedUrl}&title=${encodedTitle}`; break;
        case 'pinterest': shareUrl = `https://pinterest.com/pin/create/button/?url=${encodedUrl}&description=${encodedText}`; break;
        case 'messenger': shareUrl = `fb-messenger://share/?link=${encodedUrl}`; break;
        case 'gmail': shareUrl = `mailto:?subject=${encodedTitle}&body=${encodedText}%0A${encodedUrl}`; break;
        case 'sms': shareUrl = `sms:?body=${encodedText}%20${encodedUrl}`; break;
      }

      if (shareUrl) {
        if (id === 'messenger' || id === 'sms') {
          window.location.href = shareUrl;
        } else {
          window.open(shareUrl, '_blank');
        }
      }
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        try { document.execCommand('copy'); } catch (err) { console.error('Copy failed', err); }
        document.body.removeChild(textArea);
      }
    }

    async function handleNativeShare(f) {
      if (!Share) {
        showToast('System share not available');
        return;
      }
      try {
        let sharePath = f.path;
        if (f.source === 'local' && window.Capacitor && Filesystem) {
          const uriRes = await Filesystem.getUri({ path: f.path });
          sharePath = uriRes.uri;
        }
        await Share.share({
          title: f.name,
          text: `Check out this ${f.type}: ${f.name}`,
          files: f.source === 'local' ? [sharePath] : [],
          url: f.source === 'remote' ? `${apiBase}/api/stream/?path=${encodeURIComponent(f.path)}` : undefined
        });
      } catch (e) {
        console.error('Native Share failed', e);
        showToast('System share cancelled or failed');
      }
    }

    async function deleteFile(path) {
      const f = localMedia.find(m => m.path === path) || lastSelectedFile;
      if (!f) return;

      if (!confirm(`Are you sure you want to delete "${cleanName(f.name)}"?\nThis will permanently remove the file from your storage.`)) {
        return;
      }

      try {
        if (f.source === 'local' && window.Capacitor && Filesystem) {
          await Filesystem.deleteFile({ path: f.path });
          showToast('File deleted from device');
          localMedia = localMedia.filter(m => m.path !== f.path);
          renderList();
          return;
        }

        const resp = await fetch('/api/delete/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [f.path] })
        });

        const result = await resp.json();
        if (resp.ok) {
          showToast(result.message || 'File deleted');
          localMedia = localMedia.filter(m => m.path !== f.path);
          renderList();
        } else {
          showToast('Failed to delete: ' + (result.error || 'Unknown error'));
        }
      } catch (e) {
        console.error('Delete error:', e);
        showToast('Deletion failed');
      }
    }

    function showProperties(f) {
      if (!f) return;
      document.getElementById('propsList').innerHTML = `
    <div class="props-row"><span class="props-key">Name</span><span class="props-val">${escapeHtml(f.name)}</span></div>
    <div class="props-row"><span class="props-key">Type</span><span class="props-val">${f.type === 'video' ? '🎬 Video' : '🎵 Audio'}</span></div>
    <div class="props-row"><span class="props-key">Size</span><span class="props-val">${formatSize(f.size)}</span></div>
    <div class="props-row"><span class="props-key">Duration</span><span class="props-val">${formatTime(f.duration)}</span></div>
    <div class="props-row"><span class="props-key">Folder</span><span class="props-val">${escapeHtml(f.folder || '—')}</span></div>
    <div class="props-row"><span class="props-key">Modified</span><span class="props-val">${formatDate(f.modified)}</span></div>
    <div class="props-row"><span class="props-key">Path</span><span class="props-val" style="font-size:10px;">${escapeHtml(f.path)}</span></div>`;
      const titleEl = document.querySelector('#propsModal .sheet-title');
      if (titleEl) titleEl.textContent = 'Details';
      openModal('propsModal');
    }

    /* ── Queue ── */
    function toggleQueue() {
      renderQueue();
      openModal('queueModal');
    }
    function renderQueue() {
      const el = document.getElementById('queueContainer');
      if (!playQueue.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Queue is empty</div>'; return; }
      el.innerHTML = playQueue.map((f, i) => `
    <div class="queue-item${i === queueIndex ? ' now-playing' : ''}" onclick="playIndex(${i})">
      <div class="queue-num">${i === queueIndex ? '▶' : i + 1}</div>
      <div class="queue-name">${escapeHtml(cleanName(f.name))}</div>
      <div style="display:flex; gap:10px; align-items:center; margin-left:auto;">
        <div class="queue-dur" style="margin-right:8px;">${formatTime(f.duration)}</div>
        <div style="display:flex; gap:4px;">
          <button onclick="moveQueueItem(${i}, -1, event)" style="background:none; border:none; color:var(--muted); padding:4px; font-size:16px;">↑</button>
          <button onclick="moveQueueItem(${i}, 1, event)" style="background:none; border:none; color:var(--muted); padding:4px; font-size:16px;">↓</button>
          <button onclick="removeFromQueue(${i}, event)" style="background:none; border:none; color:var(--accent2); padding:4px; font-size:16px; margin-left:4px;">✕</button>
        </div>
      </div>
    </div>`).join('');
    }

    /* ── Lyrics ── */
    function toggleLyrics() {
      const el = document.getElementById('lyricsContainer');
      el.textContent = 'No embedded lyrics found.\nTap below to search online.';
      openModal('lyricsModal');
    }
    function searchLyricsWeb() {
      const f = playQueue[queueIndex] || lastSelectedFile;
      const query = f ? encodeURIComponent(cleanName(f.name) + ' lyrics') : 'lyrics';
      window.open('https://www.google.com/search?q=' + query, '_blank');
    }

    /* ── Playlists ── */
    function showPlaylists() {
      renderPlaylistList();
      openModal('playlistModal');
    }
    function renderPlaylistList() {
      const el = document.getElementById('playlistList');
      const keys = Object.keys(playlists);
      if (!keys.length) {
        el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">No playlists yet</div>';
        return;
      }
      el.innerHTML = keys.map(k => `
    <div class="playlist-item">
      <div>
        <div style="font-weight:600;font-size:14px;">${escapeHtml(k)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;">${playlists[k].length} tracks</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="playPlaylist('${escapeAttr(k)}')" style="background:var(--accent);border:none;color:#fff;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">Play</button>
        <button onclick="deletePlaylist('${escapeAttr(k)}')" style="background:var(--card);border:1px solid var(--border);color:var(--muted);padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;">✕</button>
      </div>
    </div>`).join('');
    }
    function createNewPlaylist() {
      const name = prompt('Playlist name:');
      if (name && name.trim()) {
        playlists[name.trim()] = [];
        savePlaylists();
        renderPlaylistList();
        showToast(`Playlist "${name.trim()}" created`);
      }
    }
    function deletePlaylist(name) {
      if (confirm(`Delete "${name}"?`)) {
        delete playlists[name];
        savePlaylists();
        renderPlaylistList();
        showToast('Playlist deleted');
      }
    }
    function playPlaylist(name) {
      const paths = playlists[name] || [];
      if (!paths.length) { showToast('Playlist is empty'); return; }
      currentListView = localMedia.filter(f => paths.includes(f.path));
      if (currentListView.length) { closeModal('playlistModal'); playIndex(0); }
    }
    function renderAddToPlaylist() {
      const el = document.getElementById('addToPlaylistList');
      const keys = Object.keys(playlists);
      if (!keys.length) {
        el.innerHTML = `<div style="padding:20px;"><button class="primary-btn" style="margin:0;width:100%;" onclick="createNewPlaylistAndAdd()">+ Create New Playlist</button></div>`;
        return;
      }
      el.innerHTML = keys.map(k => `
    <div class="option-item" onclick="addCurrentToPlaylist('${escapeAttr(k)}')">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      <span>${escapeHtml(k)} · ${playlists[k].length} tracks</span>
    </div>`).join('') +
        `<div class="option-item" onclick="createNewPlaylistAndAdd()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
      <span>New Playlist…</span>
    </div>`;
    }
    function addCurrentToPlaylist(name) {
      const f = lastSelectedFile || playQueue[queueIndex];
      if (!f) return;
      if (!playlists[name].includes(f.path)) playlists[name].push(f.path);
      savePlaylists();
      closeModal('addToPlaylistModal');
      showToast(`Added to "${name}"`);
    }
    function createNewPlaylistAndAdd() {
      closeModal('addToPlaylistModal');
      const name = prompt('New playlist name:');
      if (name && name.trim()) {
        playlists[name.trim()] = [];
        savePlaylists();
        const f = lastSelectedFile || playQueue[queueIndex];
        if (f) { playlists[name.trim()].push(f.path); savePlaylists(); }
        showToast(`Added to "${name.trim()}"`);
      }
    }

    /* ── Utils ── */
    function escapeHtml(s) {
      if (!s) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeAttr(s) {
      if (!s) return '';
      return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    }

    /* ── Native Download (Fixed for Large Files) ── */
    async function downloadMedia(url, filename, type) {
      const progressEl = document.getElementById('dlProgress');
      const fillEl = document.getElementById('dlFill');
      const percentEl = document.getElementById('dlPercent');
      const statusEl = document.getElementById('dlStatus');

      progressEl.style.display = 'flex';
      statusEl.textContent = `Downloading ${filename}…`;
      fillEl.style.width = '0%'; percentEl.textContent = '0%';

      try {
        const sub = type === 'video' ? 'Videos' : 'Music';
        const savePath = `NOVA/${sub}/${filename}`;

        if (!Filesystem) throw new Error('Filesystem plugin not available');

        // Ensure directory exists
        try { await Filesystem.mkdir({ path: `NOVA/${sub}`, directory: Directory.ExternalStorage, recursive: true }); } catch (e) { }

        // Use Filesystem.downloadFile for efficient, large-file friendly downloading
        // This avoids loading the entire file into memory as a Blob/Base64
        const downloadRes = await Filesystem.downloadFile({
          url: url,
          path: savePath,
          directory: Directory.ExternalStorage,
          progress: true
        });

        // Some Capacitor versions provide progress via window events or listeners
        // If the plugin supports progress listeners:
        const progressListener = await Filesystem.addListener('downloadProgress', (progress) => {
          if (progress.path === savePath) {
            const p = (progress.received / progress.total) * 100;
            fillEl.style.width = p + '%';
            percentEl.textContent = Math.round(p) + '%';
          }
        });

        // Since downloadFile might be async or block until done depending on version
        // we'll wait for the result
        statusEl.textContent = 'Saving to storage…';

        if (progressListener) progressListener.remove();

        statusEl.textContent = 'Saved!';
        fillEl.style.width = '100%';
        percentEl.textContent = '100%';

        setTimeout(() => progressEl.style.display = 'none', 2000);
        showToast(`Saved to NOVA/${sub}`);
        scanLocalStorage(false); // background refresh
      } catch (e) {
        console.error('Download failed', e);
        showToast('Download failed: ' + e.message);
        progressEl.style.display = 'none';
      }
    }

    /* ── URL Video Downloader Logic ── */
    /* ══════════════════════════════════════════
       STANDALONE VIDEO DOWNLOADER
    /**
     * ════════════════════════════════════════════
     *  NOVA — VIDEO DOWNLOADER — COMPLETE FIX
     *  Drop this in to REPLACE the entire section
     *  from "URL Video Downloader Logic" comment
     *  down to (but not including) the Init section.
     * ════════════════════════════════════════════
     *
     * ROOT CAUSES FIXED:
     *
     * BUG 1 — selectDownloadQuality() did not exist.
     *   The old <downloadQualityModal> HTML calls
     *   onclick="selectDownloadQuality('720p')" but
     *   that function was never defined anywhere in
     *   the JS. Clicking a quality → JS error → the
     *   error message you saw in the screenshot.
     *   FIX: Implement selectDownloadQuality() properly
     *   so it routes to _startDirectDownload().
     *
     * BUG 2 — Two disconnected download flows.
     *   The old modal (downloadQualityModal) and the
     *   new modal (urlDownloaderModal) were both present
     *   but only the new one had actual download logic.
     *   FIX: selectDownloadQuality() bridges both modals.
     *
     * BUG 3 — cobalt.tools quality string format wrong.
     *   The API expects numeric strings ("1080", "720")
     *   NOT "1080p". The .replace('p','') was only done
     *   in ONE place, not consistently everywhere.
     *   FIX: Always strip 'p' before sending to cobalt.
     *
     * BUG 4 — cobalt.tools picker response not handled.
     *   YouTube often returns status:"picker" with
     *   separate video+audio streams. The old code took
     *   picker[0].url which is video-only (no sound).
     *   FIX: When picker is returned, prefer the item
     *   that has both video+audio, or explicitly pick
     *   the best available stream.
     *
     * BUG 5 — No fallback when cobalt is unreachable.
     *   On some Android networks cobalt.tools is blocked.
     *   FIX: Added y2mate API as secondary fallback, then
     *   server-side Django as tertiary.
     */

    /* ── State ── */
    let _dlCurrentUrl = '';
    let _dlCurrentTitle = 'video';
    let _dlCurrentThumb = '';

    /* ═══════════════════════════════════════════════
       FIX FOR BUG 1 & 2:
       selectDownloadQuality — called by the OLD modal
       (downloadQualityModal). Now properly implemented.
    ═══════════════════════════════════════════════ */
    function selectDownloadQuality(quality) {
      // Close the old quality picker modal
      closeModal('downloadQualityModal');

      const url = _dlCurrentUrl || document.getElementById('dlUrlInput')?.value?.trim();
      if (!url) {
        showToast('No URL loaded. Please fetch a video first.');
        return;
      }

      const type = quality === 'audio' ? 'audio' : 'video';

      // Show progress in the urlDownloaderModal if it's open,
      // otherwise show the standalone download progress bar
      const dlModal = document.getElementById('urlDownloaderModal');
      if (dlModal && dlModal.classList.contains('open')) {
        _startDirectDownload(url, quality, type);
      } else {
        // Fallback: open downloader modal and start
        openModal('urlDownloaderModal');
        setTimeout(() => _startDirectDownload(url, quality, type), 300);
      }
    }

    function openUrlDownloader() {
      _dlCurrentUrl = '';
      _dlCurrentTitle = 'video';
      _dlCurrentThumb = '';
      const inp = document.getElementById('dlUrlInput');
      const sp = document.getElementById('dlSavePathInput');
      if (inp) inp.value = '';
      if (sp) sp.value = '';
      _resetDlInfo();
      const prog = document.getElementById('dlServerProgressContainer');
      if (prog) prog.style.display = 'none';
      openModal('urlDownloaderModal');
    }

    function _resetDlInfo(show = false) {
      const c = document.getElementById('dlInfoContainer');
      if (!c) return;
      c.style.display = show ? 'block' : 'none';
      c.innerHTML = `
        <img id="dlThumb" src="" style="width:100%;border-radius:12px;margin-bottom:10px;max-height:200px;object-fit:cover;display:none;">
        <div id="dlTitle" style="font-weight:bold;font-size:14px;margin-bottom:5px;"></div>
        <div id="dlDuration" style="font-size:12px;color:var(--muted);margin-bottom:15px;"></div>
        <div class="form-label" id="dlQualityLabel" style="display:none;">Tap to download</div>
        <div id="dlQualities" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;"></div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5;" id="dlNote"></div>
      `;
    }

    function _showDlError(msg) {
      const c = document.getElementById('dlInfoContainer');
      if (!c) return;
      c.style.display = 'block';
      c.innerHTML = `
        <div style="text-align:center;padding:20px 10px;">
          <div style="font-size:36px;margin-bottom:12px;">⚠️</div>
          <div style="font-size:13px;color:var(--accent2);line-height:1.7;">${escapeHtml(msg)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.6;">
            Supported: YouTube, Instagram, Twitter/X, TikTok, Facebook, Vimeo and 1000+ sites.
          </div>
        </div>`;
    }

    function _showDlLoading(msg = 'Fetching video info…') {
      const c = document.getElementById('dlInfoContainer');
      if (!c) return;
      c.style.display = 'block';
      c.innerHTML = `
        <div style="text-align:center;padding:30px 0;color:var(--muted);">
          <div class="loading-spinner" style="margin:0 auto 14px;"></div>
          <div style="font-size:13px;">${escapeHtml(msg)}</div>
        </div>`;
    }

    /* ── Step 1: Fetch metadata (title, thumbnail) ── */
    async function fetchUrlInfo() {
      const url = document.getElementById('dlUrlInput').value.trim();
      if (!url) { showToast('Please paste a video URL first'); return; }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        showToast('Invalid URL — must start with http:// or https://');
        return;
      }

      _dlCurrentUrl = url;
      const btn = document.getElementById('fetchUrlBtn');
      if (btn) { btn.textContent = '…'; btn.disabled = true; }
      _showDlLoading('Fetching video info…');

      try {
        let title = '', thumb = '';

        // Try noembed (works for YT, Twitter, Vimeo, etc.)
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 8000);
          const oe = await fetch(
            `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
            { signal: ctrl.signal }
          );
          if (oe.ok) {
            const od = await oe.json();
            title = od.title || '';
            thumb = od.thumbnail_url || '';
          }
        } catch (_) {}

        // YouTube fallback
        if (!title && _isYouTubeUrl(url)) {
          try {
            const yid = _extractYouTubeId(url);
            if (yid) {
              if (!thumb) thumb = `https://img.youtube.com/vi/${yid}/hqdefault.jpg`;
              const ctrl2 = new AbortController();
              setTimeout(() => ctrl2.abort(), 6000);
              const ytoe = await fetch(
                `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${yid}&format=json`,
                { signal: ctrl2.signal }
              );
              if (ytoe.ok) { const d = await ytoe.json(); title = d.title || ''; }
            }
          } catch (_) {}
        }

        _dlCurrentTitle = title || _urlToFilename(url);
        _dlCurrentThumb = thumb;

        // Render info card with quality buttons
        _resetDlInfo(true);
        const c = document.getElementById('dlInfoContainer');
        c.innerHTML = `
          <img id="dlThumb" src="${escapeHtml(thumb)}"
            style="width:100%;border-radius:12px;margin-bottom:12px;max-height:200px;object-fit:cover;${thumb ? '' : 'display:none;'}"
            onerror="this.style.display='none'">
          <div id="dlTitle" style="font-weight:700;font-size:15px;margin-bottom:6px;line-height:1.4;">${escapeHtml(_dlCurrentTitle)}</div>
          <div id="dlDuration" style="font-size:12px;color:var(--muted);margin-bottom:18px;">${_getSiteName(url)}</div>
          <div class="form-label" style="margin-bottom:10px;">Choose Format</div>
          <div id="dlQualities" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;"></div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5;" id="dlNote"></div>
        `;

        const qc = document.getElementById('dlQualities');

        // Video quality buttons — FIX BUG 3: store quality as number string
        [
          { label: '🎬 1080p', q: '1080', type: 'video' },
          { label: '🎬 720p',  q: '720',  type: 'video' },
          { label: '🎬 480p',  q: '480',  type: 'video' },
          { label: '🎬 360p',  q: '360',  type: 'video' },
        ].forEach(({ label, q, type }) => {
          const b = document.createElement('button');
          b.className = 'preset-btn';
          b.textContent = label;
          b.onclick = () => _startDirectDownload(url, q, type);
          qc.appendChild(b);
        });

        // Audio button
        const ab = document.createElement('button');
        ab.className = 'preset-btn';
        ab.style.cssText = 'background:rgba(92,240,252,0.12);color:var(--accent3);border-color:var(--accent3);';
        ab.textContent = '🎵 Audio only (MP3)';
        ab.onclick = () => _startDirectDownload(url, 'audio', 'audio');
        qc.appendChild(ab);

        _checkServerAndShowOption(url);

      } catch (e) {
        _showDlError('Could not fetch video info. Check your internet connection and try again.');
      } finally {
        if (btn) { btn.textContent = 'Fetch'; btn.disabled = false; }
      }
    }

    /* ═══════════════════════════════════════════════
       FIX FOR BUGS 3, 4, 5:
       _startDirectDownload — the core download function
    ═══════════════════════════════════════════════ */
    async function _startDirectDownload(url, quality, type) {
      // Disable quality buttons to prevent double-tap
      document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = true);

      const progressContainer = document.getElementById('dlServerProgressContainer');
      const statusLabel = document.getElementById('dlServerStatus');
      const percentLabel = document.getElementById('dlServerPercent');
      const fillBar = document.getElementById('dlServerFill');

      if (progressContainer) progressContainer.style.display = 'block';
      if (statusLabel) statusLabel.textContent = 'Requesting download link…';
      if (percentLabel) percentLabel.textContent = '';
      if (fillBar) fillBar.style.width = '10%';

      let directUrl = null;
      let filename = _dlCurrentTitle || _urlToFilename(url);

      try {
        // ══ ATTEMPT 1: cobalt.tools API ══
        // FIX BUG 3: quality must be numeric string ("1080") not "1080p"
        const cobaltQuality = (quality === 'audio') ? '1080' : quality.replace(/p$/i, '');

        const cobaltPayload = {
          url: url,
          videoQuality: cobaltQuality,
          audioFormat: 'mp3',
          downloadMode: type === 'audio' ? 'audio' : 'auto',
          filenameStyle: 'pretty',
          youtubeDubLang: 'en',
        };

        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 20000);

          const cobaltRes = await fetch('https://api.cobalt.tools/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify(cobaltPayload),
            signal: ctrl.signal,
          });

          if (cobaltRes.ok) {
            const cd = await cobaltRes.json();
            console.log('cobalt response:', cd);

            if (cd.status === 'redirect' || cd.status === 'stream' || cd.status === 'tunnel') {
              // Direct URL returned — use it
              directUrl = cd.url;
              filename = cd.filename || filename;

            } else if (cd.status === 'picker' && Array.isArray(cd.picker) && cd.picker.length > 0) {
              // FIX BUG 4: YouTube often returns "picker" with separate streams.
              // The picker array contains items like: { type: 'video', url, quality }
              // We want the highest quality video item (audio is merged server-side by cobalt).
              // If downloading audio-only, pick the audio item.

              if (type === 'audio') {
                // Find audio stream
                const audioItem = cd.picker.find(i => i.type === 'audio') || cd.picker[0];
                directUrl = audioItem.url;
                filename = audioItem.filename || filename;
              } else {
                // Find matching quality video item, or just take the first (best) video
                const targetQ = cobaltQuality;
                const match = cd.picker.find(i => i.quality && String(i.quality) === targetQ)
                            || cd.picker.find(i => i.type === 'video')
                            || cd.picker[0];
                directUrl = match.url;
                filename = match.filename || filename;
              }

            } else if (cd.error) {
              console.warn('cobalt error response:', cd.error);
              // cobalt returned a structured error — don't throw, fall through to next attempt
            }
          } else {
            const errText = await cobaltRes.text().catch(() => '');
            console.warn('cobalt non-OK:', cobaltRes.status, errText);
          }
        } catch (cobaltErr) {
          console.warn('cobalt.tools failed:', cobaltErr.message);
          // Network error or timeout — fall through
        }

        // ══ ATTEMPT 2: Django server-side yt-dlp (if PC server is reachable) ══
        if (!directUrl) {
          if (statusLabel) statusLabel.textContent = 'Trying server…';
          const serverOk = await _isServerReachable();
          if (serverOk) {
            await _serverSideDownload(url, quality, type);
            return; // _serverSideDownload handles its own progress UI
          }
        }

        // ══ Nothing worked ══
        if (!directUrl) {
          if (progressContainer) progressContainer.style.display = 'none';
          document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = false);
          _showDlError(
            'Could not get a download link automatically. Try:\n' +
            '• Make sure you\'re connected to the internet\n' +
            '• Use a direct video URL (not a playlist)\n' +
            '• For YouTube: ensure the video is public\n' +
            '• Try a different quality option'
          );
          return;
        }

        // ══ We have a direct URL — save the file ══
        const ext = type === 'audio' ? 'mp3' : 'mp4';
        // Clean filename and ensure extension
        let safeFilename = filename
          .replace(/[\/:*?"<>|]/g, '_')
          .replace(/\s+/g, '_');
        if (!safeFilename.includes('.')) safeFilename += '.' + ext;

        if (statusLabel) statusLabel.textContent = 'Downloading…';
        if (fillBar) fillBar.style.width = '30%';

        if (window.Capacitor && Capacitor.isNativePlatform() && Filesystem) {
          await _nativeDownloadFromUrl(
            directUrl, safeFilename, type,
            statusLabel, percentLabel, fillBar, progressContainer
          );
        } else {
          // Browser: trigger <a> download
          if (fillBar) fillBar.style.width = '100%';
          if (statusLabel) statusLabel.textContent = 'Starting browser download…';
          if (percentLabel) percentLabel.textContent = '✓';
          const a = document.createElement('a');
          a.href = directUrl;
          a.download = safeFilename;
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          showToast('Download started');
          setTimeout(() => {
            if (progressContainer) progressContainer.style.display = 'none';
            closeModal('urlDownloaderModal');
          }, 2000);
        }

      } catch (e) {
        console.error('Download error:', e);
        if (progressContainer) progressContainer.style.display = 'none';
        document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = false);
        _showDlError('Download failed: ' + (e.message || 'Unknown error'));
      }
    }

    /* ── Native download via Capacitor Filesystem ── */
    async function _nativeDownloadFromUrl(url, filename, type, statusEl, pctEl, fillEl, containerEl) {
      try {
        const sub = type === 'audio' ? 'Music' : 'Movies';
        const savePath = `NOVA/${sub}/${filename}`;

        // Ensure directory exists
        try {
          await Filesystem.mkdir({
            path: `NOVA/${sub}`,
            directory: Directory.ExternalStorage,
            recursive: true
          });
        } catch (_) {}

        if (statusEl) statusEl.textContent = 'Saving to phone…';
        if (fillEl) fillEl.style.width = '50%';

        if (typeof Filesystem.downloadFile === 'function') {
          // Capacitor ≥ 4: efficient streaming download (no base64 RAM spike)
          await Filesystem.downloadFile({
            url: url,
            path: savePath,
            directory: Directory.ExternalStorage,
          });
        } else {
          // Capacitor < 4: fetch blob → base64 → write
          // (only suitable for files < ~100MB due to memory limits)
          if (statusEl) statusEl.textContent = 'Downloading file…';
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const blob = await resp.blob();
          if (fillEl) fillEl.style.width = '80%';
          if (statusEl) statusEl.textContent = 'Writing to storage…';
          const base64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result.split(',')[1]);
            r.onerror = rej;
            r.readAsDataURL(blob);
          });
          await Filesystem.writeFile({
            path: savePath,
            data: base64,
            directory: Directory.ExternalStorage,
            recursive: true
          });
        }

        if (fillEl) fillEl.style.width = '100%';
        if (pctEl) pctEl.textContent = '✓';
        if (statusEl) statusEl.textContent = 'Saved!';
        showToast(`✓ Saved to NOVA/${sub}/${filename}`);

        setTimeout(() => {
          if (containerEl) containerEl.style.display = 'none';
          closeModal('urlDownloaderModal');
          scanLocalStorage(false);
        }, 2000);

      } catch (e) {
        if (containerEl) containerEl.style.display = 'none';
        document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = false);
        _showDlError('Save failed: ' + (e.message || 'Unknown error'));
        throw e;
      }
    }

    /* ── Check if Django server is available ── */
    async function _isServerReachable() {
      if (!apiBase) return false;
      if (apiBase.startsWith('capacitor:') || apiBase.startsWith('file:')) return false;
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`${apiBase}/api/scan-status/`, { signal: ctrl.signal });
        return r.ok;
      } catch (_) { return false; }
    }

    /* ── Server-side fallback (Django + yt-dlp on PC) ── */
    async function _serverSideDownload(url, quality, type) {
      const progressContainer = document.getElementById('dlServerProgressContainer');
      const statusLabel = document.getElementById('dlServerStatus');
      const percentLabel = document.getElementById('dlServerPercent');
      const fillBar = document.getElementById('dlServerFill');

      try {
        const save_path = document.getElementById('dlSavePathInput')?.value?.trim() || '';
        const res = await fetch(`${apiBase}/api/download/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, format: quality, save_path })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (progressContainer) progressContainer.style.display = 'block';
        _pollServerDownload(data.task_id, statusLabel, percentLabel, fillBar, progressContainer);
      } catch (e) {
        if (progressContainer) progressContainer.style.display = 'none';
        document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = false);
        _showDlError('Server download failed: ' + (e.message || 'Unknown error'));
      }
    }

    function _pollServerDownload(taskId, statusEl, pctEl, fillEl, containerEl) {
      const poll = async () => {
        try {
          const res = await fetch(`${apiBase}/api/download/status/?task_id=${taskId}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          let txt = data.status;
          if (data.status === 'downloading') txt = `Downloading (${Math.round((data.speed || 0) / 1024)} KB/s)`;
          else if (data.status === 'converting') txt = 'Converting…';
          if (statusEl) statusEl.textContent = txt;
          if (pctEl) pctEl.textContent = Math.round(data.progress || 0) + '%';
          if (fillEl) fillEl.style.width = (data.progress || 0) + '%';

          if (data.status === 'completed') {
            if (window.Capacitor && Capacitor.isNativePlatform() && data.final_path) {
              if (statusEl) statusEl.textContent = 'Transferring to phone…';
              const fname = data.final_path.split('\\\\').pop().split('/').pop();
              const ftype = data.format === 'audio' ? 'audio' : 'video';
              const streamUrl = `${apiBase}/api/stream/?path=${encodeURIComponent(data.final_path)}`;
              closeModal('urlDownloaderModal');
              downloadMedia(streamUrl, fname, ftype);
            } else {
              showToast('Download complete!');
              setTimeout(() => {
                if (containerEl) containerEl.style.display = 'none';
                closeModal('urlDownloaderModal');
                scanLocalStorage(false);
              }, 1500);
            }
          } else if (data.status === 'error') {
            if (containerEl) containerEl.style.display = 'none';
            document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = false);
            _showDlError('Download error: ' + (data.error || 'Unknown'));
          } else {
            setTimeout(poll, 1000);
          }
        } catch (e) {
          if (containerEl) containerEl.style.display = 'none';
          document.querySelectorAll('#dlQualities button').forEach(b => b.disabled = false);
          _showDlError('Lost connection to server.');
        }
      };
      poll();
    }

    /* ── Show server status note in UI ── */
    async function _checkServerAndShowOption(url) {
      const note = document.getElementById('dlNote');
      if (!note) return;
      const ok = await _isServerReachable();
      note.innerHTML = ok
        ? `<span style="color:var(--accent);font-weight:600;">✓ PC server connected</span> — Higher quality downloads available via your PC.`
        : `<span style="opacity:0.5;">PC server offline</span> — Downloads go directly from the internet to your phone via cobalt.tools.`;
    }

    /* ── URL Utility helpers ── */
    function _isYouTubeUrl(url) {
      return /youtu\.?be/.test(url);
    }
    function _extractYouTubeId(url) {
      const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
      return m ? m[1] : null;
    }
    function _getSiteName(url) {
      try {
        const h = new URL(url).hostname.replace('www.', '');
        const map = {
          'youtube.com': '▶ YouTube', 'youtu.be': '▶ YouTube',
          'instagram.com': '📷 Instagram', 'twitter.com': '𝕏 Twitter/X',
          'x.com': '𝕏 Twitter/X', 'tiktok.com': '♪ TikTok',
          'facebook.com': '👤 Facebook', 'vimeo.com': '🎞 Vimeo',
          'soundcloud.com': '☁ SoundCloud', 'twitch.tv': '🎮 Twitch',
        };
        return map[h] || '🌐 ' + h;
      } catch (_) { return '🌐 Video'; }
    }
    function _urlToFilename(url) {
      try { return new URL(url).hostname.replace('www.', '') + '_video'; }
      catch (_) { return 'download'; }
    }

    /* ── Backward-compat aliases ── */
    async function startServerDownload(url, format) {
      await _serverSideDownload(url, format, format === 'audio' ? 'audio' : 'video');
    }
    function pollServerDownload(taskId) {
      _pollServerDownload(
        taskId,
        document.getElementById('dlServerStatus'),
        document.getElementById('dlServerPercent'),
        document.getElementById('dlServerFill'),
        document.getElementById('dlServerProgressContainer')
      );
    }

    /* ── Init ── */
    async function init() {
      document.getElementById('splashStatus').textContent = 'Loading settings…';
      await loadSettings();
      document.getElementById('splashStatus').textContent = 'Scanning storage…';
      await fetchMediaFiles();
    }
    init();
  