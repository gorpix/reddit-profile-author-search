// ==UserScript==
// @name         Reddit Profile Author Search
// @namespace    https://reddit.com/
// @version      1.0.2
// @description  Seamlessly restores hidden Reddit profile posts and comments using Reddit's native search results.
// @author       gorpix
// @homepageURL  https://github.com/gorpix/reddit-profile-author-search
// @supportURL   https://github.com/gorpix/reddit-profile-author-search/issues
// @downloadURL  https://raw.githubusercontent.com/gorpix/reddit-profile-author-search/main/reddit-profile-author-search.user.js
// @updateURL    https://raw.githubusercontent.com/gorpix/reddit-profile-author-search/main/reddit-profile-author-search.user.js
// @match        https://www.reddit.com/user/*
// @match        https://www.reddit.com/u/*
// @match        https://old.reddit.com/user/*
// @match        https://old.reddit.com/u/*
// @match        https://new.reddit.com/user/*
// @match        https://new.reddit.com/u/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BUTTON_CLASS = 'reddit-author-search-button';
    const FEED_CLASS = 'reddit-native-history-feed';
    const FRAME_CLASS = 'reddit-native-history-source';
    const HIDDEN_NOTICE_PATTERN = /\blikes to keep their (posts|comments) hidden\b/i;
    const FEED_OPTIONS_TEXT = 'feed options';
    // Results are present as soon as a working search page loads, so check right
    // after the frame loads and, if empty, reload and recheck (up to 2 retries).
    const FRAME_LOAD_TIMEOUT_MS = 10000;
    const RESULT_GRACE_MS = 750;
    const MAX_ATTEMPTS = 3;
    const MAX_MORE_WAIT_MS = 6000;

    let scheduled = false;
    let session = null;

    const style = document.createElement('style');
    style.textContent = `
        .${BUTTON_CLASS} {
            display: inline-flex !important;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 32px;
            margin-left: 8px !important;
            padding: 4px 12px !important;
            border: 0 !important;
            border-radius: 999px !important;
            background: var(--color-secondary-background, #e5ebee) !important;
            color: var(--color-secondary-plain, #1a1a1b) !important;
            font: 600 12px/1.25 Arial, sans-serif !important;
            text-decoration: none !important;
            text-transform: none !important;
            vertical-align: middle !important;
            white-space: nowrap !important;
            cursor: pointer !important;
        }

        .${BUTTON_CLASS}:hover,
        .${BUTTON_CLASS}:focus-visible {
            background: var(--color-secondary-background-hover, #d8e0e5) !important;
            color: var(--color-secondary-plain, #1a1a1b) !important;
            text-decoration: none !important;
        }

        /* The source frame must sit inside the window: Reddit's search loads more
           results only when its scroll marker is on screen, and an off-screen frame
           never counts as on screen. Transparent, click-through and behind the page. */
        .${FRAME_CLASS} {
            position: fixed !important;
            left: 0 !important;
            top: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            border: 0 !important;
            opacity: 0 !important;
            pointer-events: none !important;
            z-index: -1 !important;
        }

        .${FEED_CLASS},
        .${FEED_CLASS} > search-telemetry-tracker,
        .${FEED_CLASS} > [data-testid="search-sdui-post"] {
            display: block !important;
            width: 100% !important;
        }

        .${FEED_CLASS} {
            background: var(--color-neutral-background, transparent);
        }

        .${FEED_CLASS} > .ras-native-divider {
            margin: 0 var(--rem16, 16px) !important;
            border: 0 !important;
            border-bottom: 1px solid var(--color-neutral-border-weak, #e5e7eb) !important;
        }

        .${FEED_CLASS} > .ras-native-sentinel {
            width: 100%;
            height: 2px;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    function normalizeText(value) {
        return (value || '').trim().replace(/\s+/g, ' ');
    }

    function getProfileUsername() {
        const match = location.pathname.match(/^\/(?:user|u)\/([^/?#]+)/i);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function getPathListingType() {
        if (/\/(?:comments)(?:\/|$)/i.test(location.pathname)) return 'comments';
        if (/\/(?:submitted|posts)(?:\/|$)/i.test(location.pathname)) return 'posts';
        return null;
    }

    // Follow the profile's Feed options sort (?sort=hot|new|top&t=...), defaulting to new.
    function getProfileSort() {
        const params = new URLSearchParams(location.search);
        const requested = (params.get('sort') || '').toLowerCase();
        const sort = ['hot', 'new', 'top'].includes(requested) ? requested : 'new';
        const requestedTime = (params.get('t') || '').toLowerCase();
        const time = sort === 'top' && ['hour', 'day', 'week', 'month', 'year', 'all'].includes(requestedTime)
            ? requestedTime
            : '';
        return { sort, time };
    }

    function getSessionToken(username, type) {
        const { sort, time } = getProfileSort();
        return `${username.toLowerCase()}:${type}:${location.pathname}:${sort}:${time}`;
    }

    function getSearchUrl(username, type) {
        // Keep the frame same-origin so its native result nodes can be adopted.
        const { sort, time } = getProfileSort();
        const url = new URL('/search/', location.origin);
        url.searchParams.set('q', `author:"${username}"`);
        url.searchParams.set('type', type);
        url.searchParams.set('sort', sort);
        if (time) url.searchParams.set('t', time);
        return url.href;
    }

    function isVisible(element) {
        return element.getClientRects().length > 0;
    }

    function findHiddenNotice() {
        const candidates = Array.from(document.querySelectorAll(
            'p, span, div, section, h1, h2, h3, h4, [role="status"]'
        )).flatMap((element) => {
            if (element.closest(`.${FEED_CLASS}`) || !isVisible(element)) return [];
            const text = normalizeText(element.textContent);
            const match = text.length <= 1000 ? text.match(HIDDEN_NOTICE_PATTERN) : null;
            return match ? [{ element, text, type: match[1].toLowerCase() }] : [];
        });

        candidates.sort((a, b) => a.text.length - b.text.length);
        if (!candidates.length) return null;

        const found = candidates[0];
        let target = found.element;
        const originalLength = found.text.length;

        // Capture the compact empty-state wrapper, without consuming the full feed.
        while (target.parentElement && !target.parentElement.matches('body, main, [role="main"]')) {
            const parent = target.parentElement;
            const parentText = normalizeText(parent.textContent);
            if (!HIDDEN_NOTICE_PATTERN.test(parentText) || parentText.length > originalLength + 240) break;
            target = parent;
        }

        return { target, type: found.type };
    }

    function findFeedOptionsLabel() {
        const candidates = document.querySelectorAll(
            'button, h1, h2, h3, h4, h5, h6, legend, strong, p, span, div'
        );

        for (const element of candidates) {
            if (element.closest(`.${BUTTON_CLASS}`) || !isVisible(element)) continue;
            if (normalizeText(element.textContent).toLowerCase() !== FEED_OPTIONS_TEXT) continue;

            const childHasSameText = Array.from(element.children).some((child) =>
                normalizeText(child.textContent).toLowerCase() === FEED_OPTIONS_TEXT
            );
            if (!childHasSameText) return element;
        }

        return null;
    }

    function addOrUpdateButton(username) {
        const type = getPathListingType() || 'posts';
        const searchUrl = getSearchUrl(username, type);
        const existingButtons = document.querySelectorAll(`.${BUTTON_CLASS}`);

        if (existingButtons.length) {
            existingButtons.forEach((button) => {
                button.href = searchUrl;
                button.title = `Search Reddit for author:"${username}"`;
                button.setAttribute('aria-label', `Show all ${type} by ${username}`);
            });
            return;
        }

        const label = findFeedOptionsLabel();
        if (!label) return;

        const button = document.createElement('a');
        button.className = BUTTON_CLASS;
        button.href = searchUrl;
        button.textContent = 'Show all content';
        button.title = `Search Reddit for author:"${username}"`;
        button.setAttribute('aria-label', `Show all ${type} by ${username}`);

        const feedOptionsButton = label.closest('button');
        (feedOptionsButton || label).insertAdjacentElement('afterend', button);
    }

    function delay(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    function resultRoots(frameDocument, type) {
        if (type === 'posts') {
            return Array.from(frameDocument.querySelectorAll('[data-testid="search-sdui-post"]'));
        }

        return Array.from(frameDocument.querySelectorAll('[data-testid="search-sdui-comment-unit"]'))
            .map((unit) => unit.closest('search-telemetry-tracker') || unit);
    }

    function resultKey(root, type) {
        const context = root.getAttribute('data-faceplate-tracking-context')
            || root.querySelector('[data-faceplate-tracking-context]')?.getAttribute('data-faceplate-tracking-context')
            || '';
        const idPattern = type === 'comments' ? /"comment"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/ : /"post"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/;
        const id = context.match(idPattern)?.[1];
        const firstLink = root.querySelector('a[href]')?.getAttribute('href');
        return id || firstLink || context || normalizeText(root.textContent).slice(0, 300);
    }

    async function waitForResults(currentSession) {
        await Promise.race([currentSession.frame.loaded, delay(FRAME_LOAD_TIMEOUT_MS)]);
        const deadline = Date.now() + RESULT_GRACE_MS;
        while (!currentSession.cancelled && Date.now() < deadline) {
            const frameDocument = currentSession.frame.contentDocument;
            if (frameDocument) {
                const roots = resultRoots(frameDocument, currentSession.type);
                if (roots.length) return roots;

                const mainText = normalizeText(frameDocument.querySelector('main')?.textContent);
                if (/couldn.t find any results|no results/i.test(mainText)) return [];
            }
            await delay(250);
        }
        return [];
    }

    // Reddit renders counts with custom elements (e.g. <faceplate-number>) whose
    // server-rendered text is already present. When a cloned copy connects to this
    // page, the element renders again and appends to that text ("20" -> "2020").
    // Swap such leaf custom elements for inert spans holding the original text.
    const COUNT_TEXT_PATTERN = /^[\d.,]+\s*[KkMmBb]?$/;

    function freezeCountElements(original, clone) {
        const originals = original.querySelectorAll('*');
        const clones = clone.querySelectorAll('*');
        if (originals.length !== clones.length) return;

        for (let index = 0; index < clones.length; index += 1) {
            const source = originals[index];
            const target = clones[index];
            if (!target.localName.includes('-') || target.childElementCount) continue;

            const text = normalizeText(source.textContent);
            if (!COUNT_TEXT_PATTERN.test(text)) continue;

            const span = document.createElement('span');
            if (target.className) span.className = target.className;
            const label = target.getAttribute('aria-label');
            if (label) span.setAttribute('aria-label', label);
            span.textContent = text;
            target.replaceWith(span);
        }
    }

    function appendNewResults(currentSession, roots) {
        let added = 0;

        for (const root of roots) {
            const key = resultKey(root, currentSession.type);
            if (!key || currentSession.seen.has(key)) continue;
            currentSession.seen.add(key);

            if (currentSession.feed.childElementCount > 1) {
                const divider = document.createElement('hr');
                divider.className = 'ras-native-divider';
                currentSession.feed.insertBefore(divider, currentSession.sentinel);
            }

            const clone = document.importNode(root, true);
            freezeCountElements(root, clone);
            clone.removeAttribute('id');
            clone.style.display = 'block';
            currentSession.feed.insertBefore(clone, currentSession.sentinel);
            added += 1;
        }

        return added;
    }

    async function loadMore(currentSession) {
        if (currentSession.loadingMore || currentSession.finished || currentSession.cancelled) return;
        const frameWindow = currentSession.frame.contentWindow;
        const frameDocument = currentSession.frame.contentDocument;
        if (!frameWindow || !frameDocument) return;

        currentSession.loadingMore = true;
        const previousCount = resultRoots(frameDocument, currentSession.type).length;
        frameWindow.scrollTo(0, frameDocument.documentElement.scrollHeight);

        const deadline = Date.now() + MAX_MORE_WAIT_MS;
        let roots = resultRoots(frameDocument, currentSession.type);
        while (!currentSession.cancelled && roots.length <= previousCount && Date.now() < deadline) {
            await delay(300);
            roots = resultRoots(frameDocument, currentSession.type);
        }

        if (!currentSession.cancelled) {
            const added = appendNewResults(currentSession, roots);
            if (!added) {
                currentSession.noGrowthCount += 1;
                if (currentSession.noGrowthCount >= 2) {
                    currentSession.finished = true;
                    currentSession.observer?.disconnect();
                    currentSession.sentinel.remove();
                    currentSession.frame.remove();
                }
            } else {
                currentSession.noGrowthCount = 0;
            }
        }

        currentSession.loadingMore = false;

        // The observer only fires when the sentinel enters the margin. If a small
        // batch left it in range, it won't fire again, so keep loading from here.
        if (!currentSession.finished && !currentSession.cancelled && currentSession.sentinel.isConnected) {
            const top = currentSession.sentinel.getBoundingClientRect().top;
            if (top < window.innerHeight + 1000) loadMore(currentSession);
        }
    }

    function cleanupSession({ removeFeed = false } = {}) {
        if (!session) return;
        session.cancelled = true;
        session.observer?.disconnect();
        session.frame?.remove();
        if (removeFeed && session.feed) {
            // Restore Reddit's notice in place of the feed (e.g. after a sort change
            // without a full page load) so the next pass can rebuild from it.
            if (session.feed.isConnected && session.notice && !session.notice.isConnected) {
                session.feed.replaceWith(session.notice);
            } else {
                session.feed.remove();
            }
        }
        if (session.notice?.isConnected) delete session.notice.dataset.redditNativeHistoryLoading;
        session = null;
    }

    function createSourceFrame(username, type) {
        const frame = document.createElement('iframe');
        frame.className = FRAME_CLASS;
        frame.src = getSearchUrl(username, type);
        frame.tabIndex = -1;
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('title', '');
        // Listen before the frame is inserted so the load event can't be missed.
        frame.loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
        return frame;
    }

    async function integrateNativeResults(notice, username, type) {
        const token = getSessionToken(username, type);
        if (session?.token === token && session.notice?.isConnected) return;
        cleanupSession({ removeFeed: true });

        const frame = createSourceFrame(username, type);

        const feed = document.createElement('div');
        feed.className = FEED_CLASS;
        feed.dataset.username = username;
        feed.dataset.type = type;
        feed.dataset.token = token;

        const sentinel = document.createElement('div');
        sentinel.className = 'ras-native-sentinel';
        feed.appendChild(sentinel);

        const currentSession = {
            token,
            username,
            type,
            notice,
            frame,
            feed,
            sentinel,
            seen: new Set(),
            observer: null,
            loadingMore: false,
            noGrowthCount: 0,
            finished: false,
            cancelled: false,
        };
        session = currentSession;
        notice.dataset.redditNativeHistoryLoading = token;
        document.body.appendChild(frame);

        let roots = [];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            if (attempt > 1) {
                // A brand-new frame avoids reading the stale document of the failed load.
                const freshFrame = createSourceFrame(username, type);
                currentSession.frame.replaceWith(freshFrame);
                currentSession.frame = freshFrame;
            }
            roots = await waitForResults(currentSession);
            if (currentSession.cancelled || session !== currentSession) return;
            if (roots.length) break;
        }

        // Leave Reddit's own notice intact if its search genuinely has no results.
        if (!roots.length || !notice.isConnected) {
            if (notice.isConnected) notice.dataset.redditNativeHistoryFailed = token;
            delete notice.dataset.redditNativeHistoryLoading;
            cleanupSession();
            return;
        }

        appendNewResults(currentSession, roots);
        notice.replaceWith(feed);

        currentSession.observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) loadMore(currentSession);
        }, { rootMargin: '1000px 0px' });
        currentSession.observer.observe(sentinel);
    }

    function updatePage() {
        scheduled = false;
        const username = getProfileUsername();

        if (!username) {
            document.querySelectorAll(`.${BUTTON_CLASS}, .${FEED_CLASS}`).forEach((element) => element.remove());
            cleanupSession();
            return;
        }

        addOrUpdateButton(username);

        const noticeInfo = findHiddenNotice();
        const type = getPathListingType() || noticeInfo?.type || 'posts';
        const expectedToken = getSessionToken(username, type);
        const existingFeed = document.querySelector(`.${FEED_CLASS}`);

        if (existingFeed && existingFeed.dataset.token !== expectedToken) {
            cleanupSession({ removeFeed: true });
        }

        if (session && session.token !== expectedToken) {
            cleanupSession({ removeFeed: true });
        }

        if (!document.querySelector(`.${FEED_CLASS}`) && noticeInfo) {
            const loadingToken = noticeInfo.target.dataset.redditNativeHistoryLoading;
            const failedToken = noticeInfo.target.dataset.redditNativeHistoryFailed;
            if (loadingToken !== expectedToken && failedToken !== expectedToken) {
                integrateNativeResults(noticeInfo.target, username, type);
            }
        }
    }

    function scheduleUpdate() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(updatePage);
    }

    const pageObserver = new MutationObserver(scheduleUpdate);
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', scheduleUpdate);
    window.addEventListener('pageshow', scheduleUpdate);
    scheduleUpdate();
})();
