// ==UserScript==
// @name         Reddit Profile Author Search
// @namespace    https://reddit.com/
// @version      0.9-preview
// @description  Seamlessly restores hidden Reddit profile posts and comments using Reddit's native search results.
// @author       You
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
    const MAX_INITIAL_WAIT_MS = 20000;
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

        .${FRAME_CLASS} {
            position: fixed !important;
            left: -12000px !important;
            top: 0 !important;
            width: 1200px !important;
            height: 900px !important;
            border: 0 !important;
            opacity: 0 !important;
            pointer-events: none !important;
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

    function getSearchUrl(username, type) {
        // Keep the frame same-origin so its native result nodes can be adopted.
        const url = new URL('/search/', location.origin);
        url.searchParams.set('q', `author:"${username}"`);
        url.searchParams.set('type', type);
        url.searchParams.set('sort', 'new');
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
                button.setAttribute('aria-label', `Search Reddit for ${type} by ${username}`);
            });
            return;
        }

        const label = findFeedOptionsLabel();
        if (!label) return;

        const button = document.createElement('a');
        button.className = BUTTON_CLASS;
        button.href = searchUrl;
        button.textContent = 'Search Author';
        button.title = `Search Reddit for author:"${username}"`;
        button.setAttribute('aria-label', `Search Reddit for ${type} by ${username}`);

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

    async function waitForResults(currentSession, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
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
    }

    function cleanupSession({ removeFeed = false } = {}) {
        if (!session) return;
        session.cancelled = true;
        session.observer?.disconnect();
        session.frame?.remove();
        if (removeFeed) session.feed?.remove();
        if (session.notice?.isConnected) delete session.notice.dataset.redditNativeHistoryLoading;
        session = null;
    }

    async function integrateNativeResults(notice, username, type) {
        const token = `${username.toLowerCase()}:${type}:${location.pathname}`;
        if (session?.token === token && session.notice?.isConnected) return;
        cleanupSession({ removeFeed: true });

        const frame = document.createElement('iframe');
        frame.className = FRAME_CLASS;
        frame.src = getSearchUrl(username, type);
        frame.tabIndex = -1;
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('title', '');

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

        const roots = await waitForResults(currentSession, MAX_INITIAL_WAIT_MS);
        if (currentSession.cancelled || session !== currentSession) return;

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
        const expectedToken = `${username.toLowerCase()}:${type}:${location.pathname}`;
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
