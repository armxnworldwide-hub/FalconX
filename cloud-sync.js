const firebaseConfig = {
    apiKey: "AIzaSyBGByQV7o655YvsCa8_c16P6zIaMGr7Uq0",
    authDomain: "falconx-f1016.firebaseapp.com",
    projectId: "falconx-f1016",
    storageBucket: "falconx-f1016.firebasestorage.app",
    messagingSenderId: "357270984794",
    appId: "1:357270984794:web:93a4c9e3502eeeeca42063"
};

(async function initializeFalconXCloudSync() {
    const ownerStorageKey = 'falconx_cloud_owner_uid';
    const pendingStoragePrefix = 'falconx_cloud_pending_v1_';
    const migrationStoragePrefix = 'falconx_cloud_migrated_v1_';
    const lastSyncStoragePrefix = 'falconx_cloud_last_sync_';
    const collectionNames = ['favorites', 'playlists', 'recentlyPlayed', 'listeningHistory', 'userSettings', 'playbackPreferences'];
    const serverReady = Object.fromEntries(collectionNames.map((name) => [name, false]));
    const listeners = [];
    const mirrors = {
        favorites: new Map(),
        playlists: new Map(),
        recentlyPlayed: new Map(),
        listeningHistory: new Map(),
        userSettings: null,
        playbackPreferences: null
    };

    let activeUid = '';
    let authGeneration = 0;
    let migrationCandidate = null;
    let authLocalBaseline = null;
    let pending = createEmptyPending();
    const migrationPromises = new Map();
    let lastErrorKey = '';
    let lastErrorToastAt = 0;
    let lastSyncedAt = 0;
    let favoritesFlushRunning = false;
    let playlistsFlushRunning = false;
    let recentFlushRunning = false;
    let historyFlushRunning = false;
    let settingsFlushRunning = false;
    let playbackFlushRunning = false;

    function createEmptyPending() {
        return {
            favorites: {},
            playlists: {},
            recentlyPlayed: {},
            clearRecentlyPlayed: false,
            listeningHistory: [],
            userSettings: null,
            playbackPreferences: null
        };
    }

    function deepCopy(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function toMillis(value, fallback = 0) {
        if (Number.isFinite(value)) return value;
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        if (value && Number.isFinite(value.seconds)) return value.seconds * 1000;
        return fallback;
    }

    function encodeDocumentId(value) {
        const bytes = new TextEncoder().encode(String(value || ''));
        return `x_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    function safeString(value, fallback = '') {
        return typeof value === 'string' ? value : fallback;
    }

    function normalizeSong(song, fileFallback = '') {
        const file = safeString(song?.file, fileFallback).trim();
        if (!file) return null;
        return {
            file,
            title: safeString(song?.title, file.split(/[\\/]/).pop() || 'Untitled'),
            poster: safeString(song?.poster),
            artistName: safeString(song?.artistName, safeString(song?.artist)),
            artist: safeString(song?.artist, safeString(song?.artistName)),
            album: safeString(song?.album, safeString(song?.albumName)),
            duration: Number.isFinite(song?.duration) ? song.duration : 0,
            explicit: song?.explicit === true,
            addedAt: toMillis(song?.addedAt)
        };
    }

    function normalizePlaylist(id, value) {
        if (!value || typeof value !== 'object') return null;
        const songs = Array.isArray(value.songs)
            ? value.songs.map((song) => normalizeSong(song)).filter(Boolean)
            : [];
        return {
            id: safeString(value.id, id),
            name: safeString(value.name, 'Playlist') || 'Playlist',
            createdAt: toMillis(value.createdAt, Date.now()),
            artwork: safeString(value.artwork, songs[0]?.poster || ''),
            songs
        };
    }

    function normalizeSettings(value) {
        if (!value || typeof value !== 'object') return null;
        const result = {};
        if (['dark', 'light', 'amoled'].includes(value.mode)) result.mode = value.mode;
        if (['green', 'blue', 'purple', 'red', 'gold', 'orange', 'pink'].includes(value.theme)) result.theme = value.theme;
        if (typeof value.accent === 'string' && /^#[0-9a-f]{6}$/i.test(value.accent)) result.accent = value.accent;
        for (const key of ['blurEffects', 'animations', 'glass']) {
            if (typeof value[key] === 'boolean') result[key] = value[key];
        }
        return result;
    }

    function normalizePlaybackPreferences(value) {
        if (!value || typeof value !== 'object') return null;
        const result = {};
        if (Number.isFinite(value.playbackRate) && value.playbackRate >= 0.5 && value.playbackRate <= 2) {
            result.playbackRate = value.playbackRate;
        }
        for (const key of ['shuffle', 'repeat', 'resumePlayback']) {
            if (typeof value[key] === 'boolean') result[key] = value[key];
        }
        return result;
    }

    function getLibrarySong(file) {
        const found = window.findSongInLibraryByFile?.(file);
        return found?.song ? { song: found.song, artistName: found.artistName || found.song.artistName || '' } : null;
    }

    function favoriteRecord(file, fallback = {}) {
        const found = getLibrarySong(file);
        const song = found?.song || fallback;
        const artistName = found?.artistName || safeString(song.artistName, safeString(song.artist));
        const appState = window.__getCloudStatePayload?.() || {};
        const likedAt = toMillis(appState.likedSongMeta?.[file], toMillis(fallback.likedAt, Date.now()));
        return {
            file,
            title: safeString(song.title, file.split(/[\\/]/).pop() || 'Untitled'),
            artistName,
            album: safeString(song.album, safeString(song.albumName)),
            poster: safeString(song.poster),
            likedAt
        };
    }

    function normalizeRecent(value) {
        const song = normalizeSong(value);
        if (!song) return null;
        return {
            ...song,
            artistKey: safeString(value.artistKey),
            playedAt: toMillis(value.playedAt, toMillis(value.lastPlayed, Date.now())),
            lastPlayed: toMillis(value.lastPlayed, toMillis(value.playedAt, Date.now()))
        };
    }

    function serializePlaylist(value) {
        const playlist = normalizePlaylist(value.id, value);
        if (!playlist) return null;
        return {
            id: playlist.id,
            name: playlist.name,
            createdAt: playlist.createdAt,
            artwork: playlist.artwork,
            songs: playlist.songs
        };
    }

    function stablePlaylist(value) {
        const playlist = normalizePlaylist(value?.id || '', value);
        if (!playlist) return 'null';
        return JSON.stringify({
            id: playlist.id,
            name: playlist.name,
            createdAt: playlist.createdAt,
            artwork: playlist.artwork,
            songs: playlist.songs
        });
    }

    function mergePlaylistIntent(remoteValue, baseValue, desiredValue) {
        if (!desiredValue) return null;
        const desired = normalizePlaylist(desiredValue.id, desiredValue);
        const base = normalizePlaylist(baseValue?.id || desired.id, baseValue);
        const remote = normalizePlaylist(remoteValue?.id || desired.id, remoteValue);
        if (!base) return remote || desired;
        if (!remote) return null;

        const merged = { ...remote };
        if (desired.name !== base.name) merged.name = desired.name;
        if (desired.artwork !== base.artwork) merged.artwork = desired.artwork;

        const baseFiles = new Set(base.songs.map((song) => song.file));
        const desiredFiles = new Set(desired.songs.map((song) => song.file));
        const remoteByFile = new Map(remote.songs.map((song) => [song.file, song]));
        const localByFile = new Map(desired.songs.map((song) => [song.file, song]));
        const removedFiles = new Set([...baseFiles].filter((file) => !desiredFiles.has(file)));
        const baseOrder = base.songs.map((song) => song.file).filter((file) => desiredFiles.has(file));
        const desiredExistingOrder = desired.songs.map((song) => song.file).filter((file) => baseFiles.has(file));
        const reordered = baseOrder.some((file, index) => file !== desiredExistingOrder[index]);

        if (reordered) {
            const ordered = [];
            for (const song of desired.songs) {
                const remoteSong = remoteByFile.get(song.file);
                ordered.push(remoteSong || song);
                remoteByFile.delete(song.file);
            }
            for (const song of remote.songs) {
                if (!baseFiles.has(song.file) && !desiredFiles.has(song.file)) ordered.push(song);
                remoteByFile.delete(song.file);
            }
            for (const song of remoteByFile.values()) {
                if (!removedFiles.has(song.file)) ordered.push(song);
            }
            merged.songs = ordered;
        } else {
            const songs = remote.songs.filter((song) => !removedFiles.has(song.file));
            const seen = new Set(songs.map((song) => song.file));
            for (const song of desired.songs) {
                if (!seen.has(song.file)) {
                    seen.add(song.file);
                    songs.push(song);
                }
            }
            merged.songs = songs;
        }
        return merged;
    }

    function readPending(uid) {
        try {
            const stored = JSON.parse(localStorage.getItem(`${pendingStoragePrefix}${uid}`) || 'null');
            if (!stored || typeof stored !== 'object') return createEmptyPending();
            return {
                ...createEmptyPending(),
                ...stored,
                favorites: stored.favorites && typeof stored.favorites === 'object' ? stored.favorites : {},
                playlists: stored.playlists && typeof stored.playlists === 'object' ? stored.playlists : {},
                recentlyPlayed: stored.recentlyPlayed && typeof stored.recentlyPlayed === 'object' ? stored.recentlyPlayed : {},
                clearRecentlyPlayed: stored.clearRecentlyPlayed === true,
                listeningHistory: Array.isArray(stored.listeningHistory) ? stored.listeningHistory.filter((event) => event && typeof event.id === 'string' && typeof event.file === 'string') : []
            };
        } catch (error) {
            console.warn('Unable to read pending FalconX cloud changes:', error);
            return createEmptyPending();
        }
    }

    function persistPending() {
        if (!activeUid) return;
        try {
            localStorage.setItem(`${pendingStoragePrefix}${activeUid}`, JSON.stringify(pending));
        } catch (error) {
            reportSyncError(error, 'save pending changes locally');
        }
    }

    function updateSyncStatus(state, detail = '') {
        const dot = document.getElementById('syncDot');
        const label = document.getElementById('syncLabel');
        const badge = document.getElementById('syncBadge');
        if (!dot || !label || !badge) return;
        dot.className = `sync-dot${state === 'synced' ? ' synced' : state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : ''}`;
        if (state === 'synced') {
            const at = lastSyncedAt || Date.now();
            label.textContent = `Synced · ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
            badge.title = `Last synced ${new Date(at).toLocaleString()}`;
            badge.setAttribute('aria-label', badge.title);
        } else if (state === 'syncing') {
            label.textContent = 'Syncing…';
            badge.title = 'Syncing your FalconX library';
            badge.setAttribute('aria-label', badge.title);
        } else if (state === 'error') {
            label.textContent = 'Sync issue';
            badge.title = detail || 'Cloud sync needs attention';
            badge.setAttribute('aria-label', badge.title);
        } else {
            label.textContent = state === 'offline' ? 'Offline' : 'Not signed in';
            badge.title = detail || 'Your changes are saved on this device';
            badge.setAttribute('aria-label', badge.title);
        }
    }

    function markSynced() {
        if (!activeUid) return;
        lastSyncedAt = Date.now();
        try {
            localStorage.setItem(`${lastSyncStoragePrefix}${activeUid}`, String(lastSyncedAt));
        } catch (error) {
            console.warn('Unable to save FalconX last-sync time:', error);
        }
        updateSyncStatus('synced');
    }

    function reportSyncError(error, operation) {
        const code = safeString(error?.code, 'unknown');
        console.error(`FalconX cloud sync failed while attempting to ${operation}:`, error);
        if (!navigator.onLine || code.includes('unavailable') || code.includes('network')) {
            updateSyncStatus('offline', 'Offline. Changes are saved on this device and will sync when internet returns.');
            return;
        }
        const message = 'Cloud sync failed. Your changes are saved on this device and will retry.';
        updateSyncStatus('error', message);
        const now = Date.now();
        if (now - lastErrorToastAt > 8000 && typeof window.showToast === 'function') {
            lastErrorToastAt = now;
            window.showToast(message, 5000);
        }
        lastErrorKey = `${code}:${operation}`;
    }

    function reportListenerError(error, collectionName) {
        const key = `${safeString(error?.code, 'unknown')}:${collectionName}`;
        if (key !== lastErrorKey) reportSyncError(error, `listen to ${collectionName}`);
        lastErrorKey = key;
    }

    function hasPendingChanges() {
        return Object.keys(pending.favorites).length > 0
            || Object.keys(pending.playlists).length > 0
            || Object.keys(pending.recentlyPlayed).length > 0
            || pending.clearRecentlyPlayed
            || pending.listeningHistory.length > 0
            || !!pending.userSettings
            || !!pending.playbackPreferences;
    }

    function updateOverallStatus() {
        if (!activeUid) {
            updateSyncStatus('offline');
            return;
        }
        if (!navigator.onLine) {
            updateSyncStatus('offline', 'Offline. Changes are saved on this device and will sync when internet returns.');
            return;
        }
        if (hasPendingChanges() || !collectionNames.every((name) => serverReady[name])) {
            updateSyncStatus('syncing');
            return;
        }
        markSynced();
    }

    function getAppState() {
        return window.__getCloudStatePayload?.() || {
            likedSongs: [],
            likedSongMeta: {},
            playlists: {},
            recentlyPlayed: [],
            songPlayCounts: {},
            downloads: [],
            queue: []
        };
    }

    function captureLegacyLocalData() {
        const appState = getAppState();
        return {
            likedSongs: Array.isArray(appState.likedSongs) ? [...appState.likedSongs] : [],
            likedSongMeta: appState.likedSongMeta && typeof appState.likedSongMeta === 'object' ? { ...appState.likedSongMeta } : {},
            playlists: appState.playlists && typeof appState.playlists === 'object' ? deepCopy(appState.playlists) : {},
            recentlyPlayed: Array.isArray(appState.recentlyPlayed) ? deepCopy(appState.recentlyPlayed) : [],
            songPlayCounts: appState.songPlayCounts && typeof appState.songPlayCounts === 'object' ? { ...appState.songPlayCounts } : {},
            userSettings: window.__getCloudUserSettings?.() || null,
            playbackPreferences: window.__getCloudPlaybackPreferences?.() || null
        };
    }

    function applyLibraryState() {
        if (typeof window.__applyCloudState !== 'function') return;
        const current = getAppState();
        const favorites = serverReady.favorites
            ? new Map(mirrors.favorites)
            : new Map((current.likedSongs || []).map((file) => [file, favoriteRecord(file, { likedAt: current.likedSongMeta?.[file] })]));
        const playlistValues = serverReady.playlists
            ? Object.fromEntries(mirrors.playlists)
            : deepCopy(current.playlists || {});
        const recentValues = serverReady.recentlyPlayed
            ? new Map(mirrors.recentlyPlayed)
            : new Map((current.recentlyPlayed || []).map((song) => [song.file, normalizeRecent(song)]).filter(([, song]) => song));
        const historyCounts = serverReady.listeningHistory ? {} : { ...(current.songPlayCounts || {}) };

        if (migrationCandidate) {
            for (const file of migrationCandidate.likedSongs) {
                if (!favorites.has(file)) favorites.set(file, favoriteRecord(file, { likedAt: migrationCandidate.likedSongMeta[file] }));
            }
        }
        for (const [file, intent] of Object.entries(pending.favorites)) {
            if (intent === null) favorites.delete(file);
            else favorites.set(file, intent);
        }

        if (migrationCandidate) {
            for (const [id, playlist] of Object.entries(migrationCandidate.playlists)) {
                if (!playlistValues[id]) playlistValues[id] = playlist;
                else playlistValues[id] = mergeLegacyPlaylist(playlistValues[id], playlist);
            }
        }
        for (const [id, intent] of Object.entries(pending.playlists)) {
            const merged = mergePlaylistIntent(playlistValues[id] || null, intent.base, intent.desired);
            if (merged) playlistValues[id] = merged;
            else delete playlistValues[id];
        }

        if (pending.clearRecentlyPlayed) recentValues.clear();
        for (const [file, song] of Object.entries(pending.recentlyPlayed)) {
            const existing = recentValues.get(file);
            if (!existing || toMillis(song.playedAt) >= toMillis(existing.playedAt)) recentValues.set(file, song);
        }
        if (migrationCandidate && !pending.clearRecentlyPlayed) {
            for (const song of migrationCandidate.recentlyPlayed) {
                const recent = normalizeRecent(song);
                if (!recent) continue;
                const existing = recentValues.get(recent.file);
                if (!existing || recent.playedAt >= existing.playedAt) recentValues.set(recent.file, recent);
            }
        }

        for (const [id, data] of mirrors.listeningHistory) {
            if (data.type === 'aggregate' && typeof data.file === 'string') {
                historyCounts[data.file] = (historyCounts[data.file] || 0) + Math.max(0, Math.floor(Number(data.playCount) || 0));
            } else if (typeof data.file === 'string') {
                historyCounts[data.file] = (historyCounts[data.file] || 0) + 1;
            }
        }
        for (const event of pending.listeningHistory) {
            if (!mirrors.listeningHistory.has(event.id)) historyCounts[event.file] = (historyCounts[event.file] || 0) + 1;
        }
        if (migrationCandidate) {
            for (const [file, count] of Object.entries(migrationCandidate.songPlayCounts)) {
                historyCounts[file] = Math.max(historyCounts[file] || 0, Math.floor(Number(count) || 0));
            }
        }

        const likedSongs = [...favorites.keys()];
        const likedSongMeta = Object.fromEntries([...favorites].map(([file, value]) => [file, toMillis(value.likedAt, Date.now())]));
        const recentlyPlayed = [...recentValues.values()]
            .sort((a, b) => toMillis(b.playedAt, toMillis(b.lastPlayed)) - toMillis(a.playedAt, toMillis(a.lastPlayed)))
            .slice(0, 10)
            .map((song) => ({ ...song, playCount: historyCounts[song.file] || 0 }));

        window.__applyingCloudState = true;
        try {
            window.__applyCloudState({
                ...current,
                likedSongs,
                likedSongMeta,
                playlists: playlistValues,
                recentlyPlayed,
                songPlayCounts: historyCounts
            });
        } catch (error) {
            reportSyncError(error, 'apply the synchronized library');
        } finally {
            window.__applyingCloudState = false;
        }
    }

    function mergeLegacyPlaylist(remoteValue, localValue) {
        const remote = normalizePlaylist(localValue.id, remoteValue);
        const local = normalizePlaylist(localValue.id, localValue);
        if (!remote) return local;
        if (!local) return remote;
        const songs = [...remote.songs];
        const seen = new Set(songs.map((song) => song.file));
        for (const song of local.songs) {
            if (!seen.has(song.file)) {
                seen.add(song.file);
                songs.push(song);
            }
        }
        return { ...remote, songs };
    }

    function readLocalUser(uid) {
        const user = auth.currentUser;
        if (!user || user.uid !== uid) return;
        const profile = {
            uid: user.uid,
            displayName: safeString(user.displayName),
            email: safeString(user.email),
            photoURL: safeString(user.photoURL)
        };
        const profileWrite = setDoc(doc(db, 'users', uid), {
            profile,
            updatedAt: serverTimestamp()
        }, { merge: true });
        observeWrite(profileWrite, 'save your account profile');
    }

    function observeWrite(promise, operation) {
        promise.then(() => {
            lastErrorKey = '';
            if (!hasPendingChanges() && collectionNames.every((name) => serverReady[name])) markSynced();
            else updateOverallStatus();
        }).catch((error) => reportSyncError(error, operation));
    }

    function favoriteRef(uid, file) {
        return doc(db, 'users', uid, 'favorites', encodeDocumentId(file));
    }

    function playlistRef(uid, id) {
        return doc(db, 'users', uid, 'playlists', encodeDocumentId(id));
    }

    function recentRef(uid, file) {
        return doc(db, 'users', uid, 'recentlyPlayed', encodeDocumentId(file));
    }

    function historyRef(uid, id) {
        return doc(db, 'users', uid, 'listeningHistory', encodeDocumentId(id));
    }

    function categoryRef(uid, category, id) {
        return doc(db, 'users', uid, category, id);
    }

    function persistLocalLibrary(data) {
        const current = getAppState();
        window.__applyingCloudState = true;
        try {
            window.__applyCloudState({ ...current, ...data });
        } catch (error) {
            reportSyncError(error, 'save synchronized data locally');
        } finally {
            window.__applyingCloudState = false;
        }
    }

    function handleFavoritesSnapshot(snapshot, uid, generation) {
        if (generation !== authGeneration || uid !== activeUid) return;
        if (snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
            updateOverallStatus();
            return;
        }
        mirrors.favorites = new Map();
        for (const item of snapshot.docs) {
            const data = item.data();
            if (typeof data.file !== 'string' || !data.file) continue;
            mirrors.favorites.set(data.file, {
                file: data.file,
                title: safeString(data.title),
                artistName: safeString(data.artistName),
                album: safeString(data.album),
                poster: safeString(data.poster),
                likedAt: toMillis(data.likedAt, Date.now())
            });
        }
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) serverReady.favorites = true;
        applyLibraryState();
        afterSnapshot(uid, generation);
    }

    function handlePlaylistsSnapshot(snapshot, uid, generation) {
        if (generation !== authGeneration || uid !== activeUid) return;
        if (snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
            updateOverallStatus();
            return;
        }
        mirrors.playlists = new Map();
        for (const item of snapshot.docs) {
            const playlist = normalizePlaylist(item.id, item.data());
            if (playlist) mirrors.playlists.set(playlist.id, playlist);
        }
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) serverReady.playlists = true;
        applyLibraryState();
        afterSnapshot(uid, generation);
    }

    function handleRecentSnapshot(snapshot, uid, generation) {
        if (generation !== authGeneration || uid !== activeUid) return;
        if (snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
            updateOverallStatus();
            return;
        }
        mirrors.recentlyPlayed = new Map();
        for (const item of snapshot.docs) {
            const song = normalizeRecent(item.data());
            if (song) mirrors.recentlyPlayed.set(song.file, song);
        }
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) serverReady.recentlyPlayed = true;
        applyLibraryState();
        afterSnapshot(uid, generation);
    }

    function handleHistorySnapshot(snapshot, uid, generation) {
        if (generation !== authGeneration || uid !== activeUid) return;
        if (snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
            updateOverallStatus();
            return;
        }
        mirrors.listeningHistory = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) serverReady.listeningHistory = true;
        applyLibraryState();
        afterSnapshot(uid, generation);
    }

    function applyRemoteSettings() {
        const userSettings = pending.userSettings || mirrors.userSettings || migrationCandidate?.userSettings;
        const playbackPreferences = pending.playbackPreferences || mirrors.playbackPreferences || migrationCandidate?.playbackPreferences;
        window.__applyingCloudState = true;
        try {
            if (userSettings && typeof window.__applyCloudUserSettings === 'function') {
                window.__applyCloudUserSettings(userSettings);
            }
            if (playbackPreferences && typeof window.__applyCloudPlaybackPreferences === 'function') {
                window.__applyCloudPlaybackPreferences(playbackPreferences);
            }
        } catch (error) {
            reportSyncError(error, 'apply synchronized preferences');
        } finally {
            window.__applyingCloudState = false;
        }
    }

    function afterSnapshot(uid, generation) {
        if (generation !== authGeneration || uid !== activeUid) return;
        applyRemoteSettings();
        void migrateLegacyData(uid, generation);
        void flushAllPending();
        updateOverallStatus();
    }

    function subscribeToUserData(uid, generation) {
        const userCollection = (name) => collection(db, 'users', uid, name);
        const subscribe = (reference, name, handler) => {
            const unsubscribe = onSnapshot(reference, { includeMetadataChanges: true }, (snapshot) => {
                try {
                    handler(snapshot, uid, generation);
                } catch (error) {
                    reportSyncError(error, `apply ${name} updates`);
                }
            }, (error) => reportListenerError(error, name));
            listeners.push(unsubscribe);
        };
        subscribe(userCollection('favorites'), 'favorites', handleFavoritesSnapshot);
        subscribe(userCollection('playlists'), 'playlists', handlePlaylistsSnapshot);
        subscribe(query(userCollection('recentlyPlayed'), orderBy('playedAt', 'desc'), limit(40)), 'recently played', handleRecentSnapshot);
        subscribe(userCollection('listeningHistory'), 'listening history', handleHistorySnapshot);
        subscribe(categoryRef(uid, 'userSettings', 'preferences'), 'user settings', (snapshot, currentUid, currentGeneration) => {
            if (currentGeneration !== authGeneration || currentUid !== activeUid) return;
            if (snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) return;
            mirrors.userSettings = snapshot.exists() ? normalizeSettings(snapshot.data()) : null;
            if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) serverReady.userSettings = true;
            applyRemoteSettings();
            afterSnapshot(currentUid, currentGeneration);
        });
        subscribe(categoryRef(uid, 'playbackPreferences', 'current'), 'playback preferences', (snapshot, currentUid, currentGeneration) => {
            if (currentGeneration !== authGeneration || currentUid !== activeUid) return;
            if (snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) return;
            mirrors.playbackPreferences = snapshot.exists() ? normalizePlaybackPreferences(snapshot.data()) : null;
            if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) serverReady.playbackPreferences = true;
            applyRemoteSettings();
            afterSnapshot(currentUid, currentGeneration);
        });
    }

    function getLegacyCandidate(uid) {
        const ownerUid = localStorage.getItem(ownerStorageKey) || '';
        const marker = localStorage.getItem(`${migrationStoragePrefix}${uid}`);
        if (ownerUid && ownerUid !== uid) return null;
        return marker === '1' ? null : captureLegacyLocalData();
    }

    async function createIfMissing(reference, data) {
        await runTransaction(db, async (transaction) => {
            const snapshot = await transaction.get(reference);
            if (!snapshot.exists()) transaction.set(reference, data);
        });
    }

    async function runSeedTasks(tasks) {
        const chunkSize = 20;
        for (let index = 0; index < tasks.length; index += chunkSize) {
            await Promise.all(tasks.slice(index, index + chunkSize).map((task) => createIfMissing(task.reference, task.data)));
        }
    }

    function mergeLegacySource(rootData, localData) {
        const liked = new Map();
        const rootLiked = Array.isArray(rootData?.likedSongs) ? rootData.likedSongs : [];
        for (const file of rootLiked) {
            if (typeof file === 'string' && file) liked.set(file, { likedAt: toMillis(rootData.likedSongMeta?.[file]) });
        }
        for (const file of localData?.likedSongs || []) {
            if (typeof file === 'string' && file && !liked.has(file)) {
                liked.set(file, { likedAt: toMillis(localData.likedSongMeta?.[file]) });
            }
        }

        const playlists = {};
        for (const [id, playlist] of Object.entries(rootData?.playlists || {})) {
            const normalized = normalizePlaylist(id, playlist);
            if (normalized) playlists[id] = normalized;
        }
        for (const [id, playlist] of Object.entries(localData?.playlists || {})) {
            const normalized = normalizePlaylist(id, playlist);
            if (!normalized) continue;
            playlists[id] = playlists[id] ? mergeLegacyPlaylist(playlists[id], normalized) : normalized;
        }

        const recentByFile = new Map();
        const recentSources = [...(Array.isArray(rootData?.recentlyPlayed) ? rootData.recentlyPlayed : []), ...(localData?.recentlyPlayed || [])];
        for (const item of recentSources) {
            const recent = normalizeRecent(item);
            if (!recent) continue;
            const existing = recentByFile.get(recent.file);
            if (!existing || recent.playedAt >= existing.playedAt) recentByFile.set(recent.file, recent);
        }

        return {
            liked,
            playlists,
            recentlyPlayed: [...recentByFile.values()],
            songPlayCounts: localData?.songPlayCounts || {},
            userSettings: normalizeSettings(localData?.userSettings),
            playbackPreferences: normalizePlaybackPreferences(localData?.playbackPreferences)
        };
    }

    async function migrateLegacyData(uid, generation) {
        if (!activeUid || uid !== activeUid || generation !== authGeneration || !navigator.onLine) return;
        if (serverReady.favorites !== true || serverReady.playlists !== true) return;
        if (localStorage.getItem(`${migrationStoragePrefix}${uid}`) === '1') {
            migrationCandidate = null;
            return;
        }
        const existingMigration = migrationPromises.get(uid);
        if (existingMigration) return existingMigration;

        let task;
        task = (async () => {
            const userSnapshot = await getDocFromServer(doc(db, 'users', uid));
            const rootData = userSnapshot.exists() ? userSnapshot.data() : {};
            const localSource = migrationCandidate
                ? { ...migrationCandidate, recentlyPlayed: pending.clearRecentlyPlayed ? [] : migrationCandidate.recentlyPlayed }
                : null;
            const legacy = mergeLegacySource(rootData, localSource);
            const tasks = [];

            for (const [file, metadata] of legacy.liked) {
                tasks.push({
                    reference: favoriteRef(uid, file),
                    data: { ...favoriteRecord(file, metadata), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
                });
            }
            for (const [id, playlist] of Object.entries(legacy.playlists)) {
                tasks.push({
                    reference: playlistRef(uid, id),
                    data: { ...serializePlaylist(playlist), updatedAt: serverTimestamp() }
                });
            }
            for (const song of legacy.recentlyPlayed) {
                tasks.push({
                    reference: recentRef(uid, song.file),
                    data: { ...song, playedAt: song.playedAt, lastPlayedAt: serverTimestamp(), updatedAt: serverTimestamp() }
                });
            }
            for (const [file, count] of Object.entries(legacy.songPlayCounts)) {
                if (!Number.isFinite(Number(count)) || Number(count) <= 0) continue;
                tasks.push({
                    reference: historyRef(uid, `legacy_${encodeDocumentId(file)}`),
                    data: { type: 'aggregate', file, playCount: Math.floor(Number(count)), updatedAt: serverTimestamp() }
                });
            }
            if (legacy.userSettings) {
                tasks.push({
                    reference: categoryRef(uid, 'userSettings', 'preferences'),
                    data: { ...legacy.userSettings, updatedAt: serverTimestamp() }
                });
            }
            if (legacy.playbackPreferences) {
                tasks.push({
                    reference: categoryRef(uid, 'playbackPreferences', 'current'),
                    data: { ...legacy.playbackPreferences, updatedAt: serverTimestamp() }
                });
            }

            await runSeedTasks(tasks);
            if (generation !== authGeneration || uid !== activeUid) return;
            localStorage.setItem(`${migrationStoragePrefix}${uid}`, '1');
            migrationCandidate = null;
            readLocalUser(uid);
            applyLibraryState();
            applyRemoteSettings();
            markSynced();
        })().catch((error) => {
            reportSyncError(error, 'migrate existing library data');
        }).finally(() => {
            if (migrationPromises.get(uid) === task) migrationPromises.delete(uid);
        });
        migrationPromises.set(uid, task);
        return task;
    }

    function queueFavoriteDiff() {
        const appState = getAppState();
        const localFiles = new Set(Array.isArray(appState.likedSongs) ? appState.likedSongs : []);
        const baselineFiles = new Set(authLocalBaseline?.likedSongs || []);
        const knownFiles = new Set([...mirrors.favorites.keys(), ...localFiles, ...baselineFiles, ...Object.keys(pending.favorites)]);
        if (!serverReady.favorites && migrationCandidate) {
            migrationCandidate.likedSongs.forEach((file) => knownFiles.add(file));
        }
        let changed = false;
        for (const file of knownFiles) {
            const localLiked = localFiles.has(file);
            const remoteLiked = mirrors.favorites.has(file);
            if (!serverReady.favorites && !migrationCandidate) {
                const baselineLiked = baselineFiles.has(file);
                if (localLiked === baselineLiked) {
                    if (Object.prototype.hasOwnProperty.call(pending.favorites, file)
                        && (pending.favorites[file] !== null) !== localLiked) {
                        delete pending.favorites[file];
                        changed = true;
                    }
                    continue;
                }
                const intent = localLiked ? favoriteRecord(file) : null;
                if (JSON.stringify(pending.favorites[file]) !== JSON.stringify(intent)) {
                    pending.favorites[file] = intent;
                    changed = true;
                }
                continue;
            }
            if (localLiked === remoteLiked && serverReady.favorites) {
                if (Object.prototype.hasOwnProperty.call(pending.favorites, file)) {
                    delete pending.favorites[file];
                    changed = true;
                }
                continue;
            }
            if (!localLiked && !serverReady.favorites && !migrationCandidate?.likedSongs.includes(file)) continue;
            const intent = localLiked ? favoriteRecord(file) : null;
            const current = pending.favorites[file];
            if (JSON.stringify(current) !== JSON.stringify(intent)) {
                pending.favorites[file] = intent;
                changed = true;
            }
        }
        if (changed) persistPending();
    }

    function queuePlaylistDiff() {
        const appState = getAppState();
        const localPlaylists = appState.playlists && typeof appState.playlists === 'object' ? appState.playlists : {};
        const baselinePlaylists = authLocalBaseline?.playlists || {};
        const ids = new Set([...mirrors.playlists.keys(), ...Object.keys(localPlaylists), ...Object.keys(baselinePlaylists), ...Object.keys(pending.playlists)]);
        if (!serverReady.playlists && migrationCandidate) {
            Object.keys(migrationCandidate.playlists).forEach((id) => ids.add(id));
        }
        let changed = false;
        for (const id of ids) {
            const remote = mirrors.playlists.get(id) || null;
            const prior = pending.playlists[id];
            if (!serverReady.playlists && !migrationCandidate) {
                const base = normalizePlaylist(id, baselinePlaylists[id]);
                const desired = normalizePlaylist(id, localPlaylists[id]);
                if ((!base && !desired) || (base && desired && stablePlaylist(base) === stablePlaylist(desired))) {
                    const priorMatches = prior
                        && ((!prior.desired && !desired) || (prior.desired && desired && stablePlaylist(prior.desired) === stablePlaylist(desired)));
                    if (prior && !priorMatches) {
                        delete pending.playlists[id];
                        changed = true;
                    }
                    continue;
                }
                const intent = { base: base ? deepCopy(base) : null, desired: desired ? deepCopy(desired) : null };
                if (JSON.stringify(prior) !== JSON.stringify(intent)) {
                    pending.playlists[id] = intent;
                    changed = true;
                }
                continue;
            }
            const base = prior ? prior.base : (serverReady.playlists ? remote : migrationCandidate?.playlists[id] || null);
            const desired = normalizePlaylist(id, localPlaylists[id]);
            if (!desired && !base && !remote) {
                if (prior) {
                    delete pending.playlists[id];
                    changed = true;
                }
                continue;
            }
            if (desired && base && stablePlaylist(desired) === stablePlaylist(base)) {
                if (prior) {
                    delete pending.playlists[id];
                    changed = true;
                }
                continue;
            }
            if (!desired && !base) continue;
            const intent = { base: base ? deepCopy(base) : null, desired: desired ? deepCopy(desired) : null };
            if (JSON.stringify(pending.playlists[id]) !== JSON.stringify(intent)) {
                pending.playlists[id] = intent;
                changed = true;
            }
        }
        if (changed) persistPending();
    }

    function queueRecentChanges(clearRemote = false) {
        if (clearRemote) {
            pending.clearRecentlyPlayed = true;
            pending.recentlyPlayed = {};
        } else {
            const appState = getAppState();
            const items = Array.isArray(appState.recentlyPlayed) ? appState.recentlyPlayed : [];
            pending.recentlyPlayed = Object.fromEntries(items.map(normalizeRecent).filter(Boolean).map((song) => [song.file, song]));
        }
        persistPending();
    }

    function addPendingHistoryEvent(file) {
        const song = favoriteRecord(file);
        const id = window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        pending.listeningHistory.push({
            id,
            file: song.file,
            title: song.title,
            artistName: song.artistName,
            album: song.album,
            poster: song.poster,
            playedAt: Date.now()
        });
        persistPending();
    }

    function queueSettings(scope, detail) {
        if (scope === 'userSettings') {
            pending.userSettings = normalizeSettings(detail || window.__getCloudUserSettings?.());
        } else {
            pending.playbackPreferences = normalizePlaybackPreferences(detail || window.__getCloudPlaybackPreferences?.());
        }
        persistPending();
    }

    window._onLocalStateChanged = (scope, detail) => {
        if (!activeUid || window.__applyingCloudState) return;
        if (scope === 'likedSongs') queueFavoriteDiff();
        else if (scope === 'playlists') queuePlaylistDiff();
        else if (scope === 'recentlyPlayed') queueRecentChanges(false);
        else if (scope === 'recentlyPlayedClear') queueRecentChanges(true);
        else if (scope === 'listeningHistory' && typeof detail === 'string') addPendingHistoryEvent(detail);
        else if (scope === 'userSettings' || scope === 'playbackPreferences') queueSettings(scope, detail);
        void flushAllPending();
        updateOverallStatus();
    };

    async function flushFavorites() {
        if (favoritesFlushRunning || !activeUid || !navigator.onLine || !serverReady.favorites) return;
        favoritesFlushRunning = true;
        const uid = activeUid;
        try {
            while (uid === activeUid && navigator.onLine) {
                const entry = Object.entries(pending.favorites)[0];
                if (!entry) break;
                const [file, intent] = entry;
                if (intent === null) await deleteDoc(favoriteRef(uid, file));
                else await setDoc(favoriteRef(uid, file), { ...intent, updatedAt: serverTimestamp() }, { merge: true });
                if (uid !== activeUid) break;
                if (pending.favorites[file] === intent) delete pending.favorites[file];
                if (intent === null) mirrors.favorites.delete(file);
                else mirrors.favorites.set(file, intent);
                persistPending();
                applyLibraryState();
            }
        } catch (error) {
            reportSyncError(error, 'sync favorites');
        } finally {
            favoritesFlushRunning = false;
            updateOverallStatus();
        }
    }

    async function flushPlaylists() {
        if (playlistsFlushRunning || !activeUid || !navigator.onLine || !serverReady.playlists) return;
        playlistsFlushRunning = true;
        const uid = activeUid;
        try {
            while (uid === activeUid && navigator.onLine) {
                const entry = Object.entries(pending.playlists)[0];
                if (!entry) break;
                const [id, intent] = entry;
                const ref = playlistRef(uid, id);
                const result = await runTransaction(db, async (transaction) => {
                    const snapshot = await transaction.get(ref);
                    const remote = snapshot.exists() ? normalizePlaylist(id, snapshot.data()) : null;
                    if (!intent.base) {
                        if (!remote && intent.desired) {
                            transaction.set(ref, { ...serializePlaylist(intent.desired), updatedAt: serverTimestamp() });
                            return intent.desired;
                        }
                        return remote;
                    }
                    if (!intent.desired) {
                        if (remote) transaction.delete(ref);
                        return null;
                    }
                    if (!remote) return null;
                    const merged = mergePlaylistIntent(remote, intent.base, intent.desired);
                    if (merged && stablePlaylist(merged) !== stablePlaylist(remote)) {
                        transaction.set(ref, { ...serializePlaylist(merged), updatedAt: serverTimestamp() }, { merge: true });
                    }
                    return merged;
                });
                if (uid !== activeUid) break;
                if (pending.playlists[id] === intent) delete pending.playlists[id];
                if (result) mirrors.playlists.set(id, normalizePlaylist(id, result));
                else mirrors.playlists.delete(id);
                persistPending();
                applyLibraryState();
            }
        } catch (error) {
            reportSyncError(error, 'sync playlists');
        } finally {
            playlistsFlushRunning = false;
            updateOverallStatus();
        }
    }

    async function deleteRemoteRecentlyPlayed(uid) {
        const reference = collection(db, 'users', uid, 'recentlyPlayed');
        while (uid === activeUid && navigator.onLine) {
            const snapshot = await getDocs(query(reference, limit(400)));
            if (snapshot.empty) return;
            const batch = writeBatch(db);
            snapshot.docs.forEach((item) => batch.delete(item.ref));
            await batch.commit();
        }
    }

    async function flushRecentlyPlayed() {
        if (recentFlushRunning || !activeUid || !navigator.onLine || !serverReady.recentlyPlayed) return;
        recentFlushRunning = true;
        const uid = activeUid;
        try {
            if (pending.clearRecentlyPlayed) {
                await deleteRemoteRecentlyPlayed(uid);
                if (uid !== activeUid) return;
                pending.clearRecentlyPlayed = false;
                mirrors.recentlyPlayed.clear();
                persistPending();
            }
            while (uid === activeUid && navigator.onLine) {
                const entry = Object.entries(pending.recentlyPlayed)[0];
                if (!entry) break;
                const [file, song] = entry;
                await setDoc(recentRef(uid, file), {
                    ...song,
                    playedAt: toMillis(song.playedAt, Date.now()),
                    lastPlayedAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                }, { merge: true });
                if (uid !== activeUid) break;
                if (pending.recentlyPlayed[file] === song) delete pending.recentlyPlayed[file];
                mirrors.recentlyPlayed.set(file, song);
                persistPending();
            }
            applyLibraryState();
        } catch (error) {
            reportSyncError(error, 'sync recently played songs');
        } finally {
            recentFlushRunning = false;
            updateOverallStatus();
        }
    }

    async function flushHistory() {
        if (historyFlushRunning || !activeUid || !navigator.onLine || !serverReady.listeningHistory) return;
        historyFlushRunning = true;
        const uid = activeUid;
        try {
            while (uid === activeUid && navigator.onLine && pending.listeningHistory.length) {
                const event = pending.listeningHistory[0];
                await setDoc(historyRef(uid, event.id), {
                    ...event,
                    type: 'event',
                    createdAt: serverTimestamp()
                }, { merge: true });
                if (uid !== activeUid) break;
                pending.listeningHistory = pending.listeningHistory.filter((item) => item.id !== event.id);
                mirrors.listeningHistory.set(event.id, { ...event, type: 'event' });
                persistPending();
                applyLibraryState();
            }
        } catch (error) {
            reportSyncError(error, 'sync listening history');
        } finally {
            historyFlushRunning = false;
            updateOverallStatus();
        }
    }

    async function flushSettings() {
        if (settingsFlushRunning || !activeUid || !navigator.onLine || !serverReady.userSettings || !pending.userSettings) return;
        settingsFlushRunning = true;
        const uid = activeUid;
        const intent = pending.userSettings;
        try {
            await setDoc(categoryRef(uid, 'userSettings', 'preferences'), { ...intent, updatedAt: serverTimestamp() }, { merge: true });
            if (uid === activeUid && pending.userSettings === intent) {
                mirrors.userSettings = intent;
                pending.userSettings = null;
                persistPending();
            }
        } catch (error) {
            reportSyncError(error, 'sync user settings');
        } finally {
            settingsFlushRunning = false;
            updateOverallStatus();
            if (activeUid && pending.userSettings && pending.userSettings !== intent) void flushSettings();
        }
    }

    async function flushPlaybackPreferences() {
        if (playbackFlushRunning || !activeUid || !navigator.onLine || !serverReady.playbackPreferences || !pending.playbackPreferences) return;
        playbackFlushRunning = true;
        const uid = activeUid;
        const intent = pending.playbackPreferences;
        try {
            await setDoc(categoryRef(uid, 'playbackPreferences', 'current'), { ...intent, updatedAt: serverTimestamp() }, { merge: true });
            if (uid === activeUid && pending.playbackPreferences === intent) {
                mirrors.playbackPreferences = intent;
                pending.playbackPreferences = null;
                persistPending();
            }
        } catch (error) {
            reportSyncError(error, 'sync playback preferences');
        } finally {
            playbackFlushRunning = false;
            updateOverallStatus();
            if (activeUid && pending.playbackPreferences && pending.playbackPreferences !== intent) void flushPlaybackPreferences();
        }
    }

    async function flushAllPending() {
        await Promise.all([
            flushFavorites(),
            flushPlaylists(),
            flushRecentlyPlayed(),
            flushHistory(),
            flushSettings(),
            flushPlaybackPreferences()
        ]);
    }

    function clearPrivateLibrary() {
        const current = getAppState();
        persistLocalLibrary({
            ...current,
            likedSongs: [],
            likedSongMeta: {},
            playlists: {},
            recentlyPlayed: [],
            songPlayCounts: {}
        });
    }

    function setAccountUi(user) {
        const loginBtn = document.getElementById('loginBtn');
        const userBar = document.getElementById('userBar');
        const name = document.getElementById('userDisplayNameMain');
        const email = document.getElementById('userEmailMain');
        const avatar = document.getElementById('userAvatarMain');
        const mobileLogin = document.getElementById('mobileLoginBtn');
        const mobileUser = document.getElementById('mobileUserBtn');
        const mobileAvatar = document.getElementById('mobileUserAvatar');
        if (user) {
            if (loginBtn) loginBtn.style.display = 'none';
            if (userBar) userBar.style.display = 'flex';
            if (name) name.textContent = user.displayName || 'User';
            if (email) email.textContent = user.email || '';
            if (avatar) avatar.src = user.photoURL || '';
            if (mobileLogin) mobileLogin.style.display = 'none';
            if (mobileUser) mobileUser.style.display = 'flex';
            if (mobileAvatar) mobileAvatar.src = user.photoURL || '';
        } else {
            if (userBar) userBar.style.display = 'none';
            if (loginBtn) loginBtn.style.display = 'block';
            if (name) name.textContent = '';
            if (email) email.textContent = '';
            if (avatar) avatar.removeAttribute('src');
            if (mobileLogin) mobileLogin.style.display = 'flex';
            if (mobileUser) mobileUser.style.display = 'none';
            if (mobileAvatar) mobileAvatar.removeAttribute('src');
        }
    }

    function stopListeners() {
        listeners.splice(0).forEach((unsubscribe) => unsubscribe());
    }

    async function handleAuthState(user) {
        const generation = ++authGeneration;
        stopListeners();
        const previousUid = activeUid;
        if (!user) {
            activeUid = '';
            migrationCandidate = null;
            authLocalBaseline = null;
            pending = createEmptyPending();
            Object.keys(serverReady).forEach((key) => { serverReady[key] = false; });
            mirrors.favorites.clear();
            mirrors.playlists.clear();
            mirrors.recentlyPlayed.clear();
            mirrors.listeningHistory.clear();
            mirrors.userSettings = null;
            mirrors.playbackPreferences = null;
            if (previousUid || localStorage.getItem(ownerStorageKey)) clearPrivateLibrary();
            localStorage.removeItem(ownerStorageKey);
            setAccountUi(null);
            updateSyncStatus('offline', 'Sign in to sync your library across devices');
            return;
        }

        const ownerUid = localStorage.getItem(ownerStorageKey) || '';
        if ((previousUid && previousUid !== user.uid) || (ownerUid && ownerUid !== user.uid)) clearPrivateLibrary();
        authLocalBaseline = captureLegacyLocalData();
        migrationCandidate = ownerUid && ownerUid !== user.uid ? null : getLegacyCandidate(user.uid);
        activeUid = user.uid;
        localStorage.setItem(ownerStorageKey, user.uid);
        pending = readPending(user.uid);
        lastSyncedAt = Number(localStorage.getItem(`${lastSyncStoragePrefix}${user.uid}`)) || 0;
        Object.keys(serverReady).forEach((key) => { serverReady[key] = false; });
        mirrors.favorites.clear();
        mirrors.playlists.clear();
        mirrors.recentlyPlayed.clear();
        mirrors.listeningHistory.clear();
        mirrors.userSettings = null;
        mirrors.playbackPreferences = null;
        setAccountUi(user);
        updateSyncStatus('syncing');
        readLocalUser(user.uid);
        subscribeToUserData(user.uid, generation);
        await migrateLegacyData(user.uid, generation);
        await flushAllPending();
        updateOverallStatus();
    }

    window.signInWithGoogle = async () => {
        try {
            const provider = new GoogleAuthProvider();
            try {
                await signInWithPopup(auth, provider);
            } catch (error) {
                if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error?.code)) {
                    await signInWithRedirect(auth, provider);
                    return;
                }
                throw error;
            }
        } catch (error) {
            reportSyncError(error, 'sign in with Google');
        }
    };

    window.signOut = async () => {
        try {
            await fbSignOut(auth);
        } catch (error) {
            reportSyncError(error, 'sign out');
        }
    };

    window._saveToCloud = () => {
        queueFavoriteDiff();
        queuePlaylistDiff();
        void flushAllPending();
    };

    window.addEventListener('offline', () => updateSyncStatus('offline', 'Offline. Changes are saved on this device and will sync when internet returns.'));
    window.addEventListener('online', () => {
        if (!activeUid) return;
        updateSyncStatus('syncing');
        void migrateLegacyData(activeUid, authGeneration);
        void flushAllPending();
    });

    const [appModule, authModule, firestoreModule] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js')
    ]);
    const { getApps, initializeApp } = appModule;
    const { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut: firebaseSignOut, onAuthStateChanged, setPersistence, browserLocalPersistence } = authModule;
    const {
        collection,
        deleteDoc,
        doc,
        getDocs,
        getDocFromServer,
        getFirestore,
        limit,
        onSnapshot,
        orderBy,
        query,
        runTransaction,
        serverTimestamp,
        setDoc,
        writeBatch
    } = firestoreModule;
    const app = getApps().find((item) => item.name === '[DEFAULT]') || initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const fbSignOut = firebaseSignOut;

    try {
        await setPersistence(auth, browserLocalPersistence);
    } catch (error) {
        reportSyncError(error, 'set sign-in persistence');
    }
    try {
        await getRedirectResult(auth);
    } catch (error) {
        reportSyncError(error, 'complete Google sign-in');
    }
    onAuthStateChanged(auth, (user) => {
        void handleAuthState(user).catch((error) => reportSyncError(error, 'load the signed-in account'));
    });
})().catch((error) => {
    console.error('FalconX Firebase initialization failed:', error);
    const dot = document.getElementById('syncDot');
    const label = document.getElementById('syncLabel');
    const badge = document.getElementById('syncBadge');
    if (dot) dot.className = 'sync-dot error';
    if (label) label.textContent = 'Sync issue';
    if (badge) {
        badge.title = 'Cloud sync could not start. Your library remains available on this device.';
        badge.setAttribute('aria-label', badge.title);
    }
    window.showToast?.('Cloud sync could not start. Your library remains available on this device.', 5000);
});
