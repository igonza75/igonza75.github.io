const clientId = '914504e648074046b05f5f459effce00';
const playlistUri = 'spotify:playlist:2SILhjFALQvICSzZbTz5py';
const redirectUri = 'https://igonza75.github.io/';

const scopes = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';

let player;
let deviceId;
let lastPosition = 0;
let lastDuration = 0;
let lastUpdated = 0;
let isPaused = true;

let spotifyReady;
const sdkReady = new Promise(function(resolve) {
    spotifyReady = resolve;
});

window.onSpotifyWebPlaybackSDKReady = function() {
    spotifyReady();
};

// Displays messages underneath the player
function showMessage(text) {
    document.getElementById('spotify-message').textContent = text;
}

// Converts milliseconds into minutes and seconds
function formatTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return minutes + ':' + String(seconds).padStart(2, '0');
}

// Creates the verification code Spotify needs for login
function createVerifier() {
    const randomBytes = crypto.getRandomValues(new Uint8Array(64));
    const characters = String.fromCharCode(...randomBytes);

    return btoa(characters)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function createChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);

    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Sends the visitor to Spotify to sign in
async function login() {
    const verifier = createVerifier();
    const state = createVerifier();
    const challenge = await createChallenge(verifier);

    sessionStorage.setItem('spotify_verifier', verifier);
    sessionStorage.setItem('spotify_state', state);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: scopes,
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: state
    });

    window.location.href = 'https://accounts.spotify.com/authorize?' + params;
}

// Saves the Spotify login information for the current session
function saveTokens(tokens) {
    sessionStorage.setItem('spotify_access_token', tokens.access_token);

    if (tokens.refresh_token) {
        sessionStorage.setItem('spotify_refresh_token', tokens.refresh_token);
    }

    const expiration = Date.now() + tokens.expires_in * 1000;
    sessionStorage.setItem('spotify_expires', expiration);
}

// Gets the login token after Spotify redirects back to the website
async function checkLogin() {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');

    if (error) {
        showMessage('Spotify login failed: ' + error);
        history.replaceState({}, '', window.location.pathname);
        return;
    }

    const code = url.searchParams.get('code');

    if (!code) {
        return;
    }

    const verifier = sessionStorage.getItem('spotify_verifier');
    const savedState = sessionStorage.getItem('spotify_state');
    const returnedState = url.searchParams.get('state');

    history.replaceState({}, '', window.location.pathname);

    sessionStorage.removeItem('spotify_verifier');
    sessionStorage.removeItem('spotify_state');

    if (!verifier || !returnedState || returnedState !== savedState) {
        throw new Error('Spotify login verification failed. Try again.');
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier
        })
    });

    if (!response.ok) {
        throw new Error('Could not connect to Spotify. Check the redirect URI.');
    }

    const tokens = await response.json();
    saveTokens(tokens);
}

// Refreshes the token when the previous one expires
async function getToken() {
    const token = sessionStorage.getItem('spotify_access_token');
    const expiration = Number(sessionStorage.getItem('spotify_expires'));

    if (token && Date.now() < expiration - 60000) {
        return token;
    }

    const refreshToken = sessionStorage.getItem('spotify_refresh_token');

    if (!refreshToken) {
        return null;
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId
        })
    });

    if (!response.ok) {
        sessionStorage.removeItem('spotify_access_token');
        return null;
    }

    const tokens = await response.json();
    saveTokens(tokens);

    return sessionStorage.getItem('spotify_access_token');
}

// Sends requests to Spotify
async function spotifyRequest(path, options = {}) {
    const token = await getToken();

    if (!token) {
        throw new Error('Spotify session expired. Please connect again.');
    }

    const response = await fetch('https://api.spotify.com/v1' + path, {
        ...options,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error('Spotify error ' + response.status + ': ' + error.slice(0, 180));
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}

// Updates the song information on the website
function updatePlayer(state) {
    if (!state) {
        return;
    }

    const track = state.track_window.current_track;

    if (track) {
        document.getElementById('track-title').textContent = track.name;

        const artists = track.artists.map(function(artist) {
            return artist.name;
        }).join(', ');

        document.getElementById('track-details').textContent =
            artists + ' · ' + track.album.name;

        const cover = track.album.images[0];

        if (cover) {
            const image = document.createElement('img');

            image.src = cover.url;
            image.alt = 'Cover art for ' + track.album.name;

            document.getElementById('album-art').replaceChildren(image);
        }
    }

    lastPosition = state.position;
    lastDuration = state.duration;
    lastUpdated = Date.now();
    isPaused = state.paused;

    document.getElementById('play-pause').textContent =
        isPaused ? '▶' : 'Ⅱ';

    updateProgress();
}

// Updates the progress bar and song timer
function updateProgress() {
    let position = lastPosition;

    if (!isPaused) {
        position += Date.now() - lastUpdated;
        position = Math.min(position, lastDuration);
    }

    document.getElementById('elapsed').textContent = formatTime(position);
    document.getElementById('duration').textContent = formatTime(lastDuration);

    let percent = 0;

    if (lastDuration > 0) {
        percent = (position / lastDuration) * 100;
    }

    document.getElementById('progress-fill').style.width = percent + '%';

    document.getElementById('progress-track').setAttribute(
        'aria-valuenow',
        Math.round(percent)
    );
}

// Starts playing my Spotify playlist
async function playPlaylist() {
    await spotifyRequest('/me/player', {
        method: 'PUT',
        body: JSON.stringify({
            device_ids: [deviceId],
            play: false
        })
    });

    await spotifyRequest('/me/player/play?device_id=' + encodeURIComponent(deviceId), {
        method: 'PUT',
        body: JSON.stringify({
            context_uri: playlistUri
        })
    });

    showMessage('Playing gatekeep on Sounds off the Shelf.');
}

// Connects the Spotify player to the website
async function startPlayer() {
    await sdkReady;

    const token = await getToken();

    if (!token) {
        return;
    }

    player = new Spotify.Player({
        name: 'Sounds off the Shelf',
        getOAuthToken: async function(callback) {
            callback(await getToken());
        },
        volume: 0.6
    });

    player.addListener('ready', function(data) {
        deviceId = data.device_id;

        document.getElementById('previous').disabled = false;
        document.getElementById('play-pause').disabled = false;
        document.getElementById('next').disabled = false;

        document.getElementById('spotify-login').textContent =
            'Play gatekeep playlist';

        showMessage('Connected! Click Play gatekeep playlist to start listening.');
    });

    player.addListener('not_ready', function() {
        deviceId = null;
        showMessage('Spotify disconnected. Reload the page to reconnect.');
    });

    player.addListener('player_state_changed', updatePlayer);

    const errors = [
        'initialization_error',
        'authentication_error',
        'account_error',
        'playback_error'
    ];

    errors.forEach(function(type) {
        player.addListener(type, function(error) {
            showMessage(type + ': ' + error.message);
        });
    });

    const connected = await player.connect();

    if (!connected) {
        showMessage('Could not connect to Spotify. Check your account and browser.');
    }
}

// Handles errors when a button is clicked
async function handleAction(action) {
    try {
        await action();
    } catch (error) {
        console.error(error);
        showMessage(error.message);
    }
}

// Spotify connect / play playlist button
document.getElementById('spotify-login').addEventListener('click', function() {
    handleAction(async function() {
        const token = await getToken();

        if (!token) {
            await login();
            return;
        }

        if (!deviceId) {
            showMessage('Waiting for Spotify to connect.');
            return;
        }

        await playPlaylist();
    });
});

// Play and pause button
document.getElementById('play-pause').addEventListener('click', function() {
    handleAction(async function() {
        const state = await player.getCurrentState();

        if (!state) {
            await playPlaylist();
            return;
        }

        await player.togglePlay();
    });
});

// Previous song button
document.getElementById('previous').addEventListener('click', function() {
    handleAction(async function() {
        const state = await player.getCurrentState();

        if (!state) {
            await playPlaylist();
            return;
        }

        await player.previousTrack();
    });
});

// Next song button
document.getElementById('next').addEventListener('click', function() {
    handleAction(async function() {
        const state = await player.getCurrentState();

        if (!state) {
            await playPlaylist();
            return;
        }

        await player.nextTrack();
    });
});

// Keeps the progress bar moving while a song plays
setInterval(updateProgress, 1000);

// Checks for an existing Spotify login when the page opens
async function initializeSpotify() {
    try {
        await checkLogin();

        const token = await getToken();

        if (token) {
            document.getElementById('spotify-login').textContent =
                'Connecting to Spotify...';

            await startPlayer();
        }
    } catch (error) {
        console.error(error);
        showMessage(error.message);
    }
}

initializeSpotify();
