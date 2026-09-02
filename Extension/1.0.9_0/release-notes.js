let posthog = null;

async function initPostHog() {
  try {
    if (window.PostHogBundle && typeof window.PostHogBundle.initPostHog === 'function') {
      posthog = await window.PostHogBundle.initPostHog({
        context: 'release_notes',
        enableRecording: false
      });
    }
  } catch (error) {
    console.error('[HaramMute] Failed to initialize PostHog on release notes:', error);
  }
}

function trackEvent(eventName, properties = {}) {
  if (window.PostHogBundle && typeof window.PostHogBundle.trackEvent === 'function') {
    window.PostHogBundle.trackEvent(eventName, properties);
  }
}

function closeReleaseNotes(delayMs = 180) {
  window.setTimeout(() => window.close(), delayMs);
}

function setList(listEl, items) {
  listEl.innerHTML = '';
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    listEl.appendChild(li);
  });
}

function configureMaxAnnouncement() {
  const banner = document.getElementById('highlightBanner');
  const changesSection = document.getElementById('changesSection');
  const secondaryCategory = document.getElementById('secondaryCategory');
  const title = document.getElementById('releaseTitle');
  const subtitle = document.getElementById('releaseSubtitle');
  const badge = document.getElementById('releaseBadge');
  const highlightTitle = document.getElementById('highlightTitle');
  const highlightText = document.getElementById('highlightText');
  const tryAgainBtn = document.getElementById('tryAgainBtn');
  const categoryTitlePrimary = document.getElementById('categoryTitlePrimary');
  const categoryTitleSecondary = document.getElementById('categoryTitleSecondary');
  const changesListPrimary = document.getElementById('changesListPrimary');
  const changesListSecondary = document.getElementById('changesListSecondary');
  const footerText = document.getElementById('releaseFooterText');
  const gotItBtn = document.getElementById('gotItBtn');

  banner.classList.add('max-announcement');
  changesSection.classList.add('max-announcement-layout');
  title.textContent = 'New: Max mode is here';
  subtitle.textContent = 'A faster option for people who process often, hit limits, or just want the smoothest workflow.';
  badge.textContent = 'Launch offer';
  highlightTitle.textContent = 'Start Max at $14.99/month';
  highlightText.textContent = 'Max launches today at the early price of $14.99/month before it returns to $19.99/month. It removes the app limits and uses faster processing.';

  categoryTitlePrimary.lastChild.textContent = 'Why people move to Max';
  setList(changesListPrimary, [
    'Unlimited videos per day',
    'No app limit on video length',
    'Faster processing',
    'Early launch price: $14.99/mo'
  ]);

  secondaryCategory?.remove();

  footerText.textContent = 'You can keep Starter if it already covers your workflow.';
  const labelNode = Array.from(gotItBtn.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
  if (labelNode) {
    labelNode.textContent = 'Maybe later ';
  }

  tryAgainBtn.style.display = 'inline-block';
  tryAgainBtn.textContent = 'See Max at $14.99/mo →';
  tryAgainBtn.addEventListener('click', () => {
    trackEvent('max_announcement_clicked', {
      source: 'update_tab',
      target_tier: 'max',
      billing_cycle: 'monthly',
      offer_price_monthly: 14.99,
      regular_price_monthly: 19.99
    });
    chrome.tabs.create({
      url: chrome.runtime.getURL('onboarding.html?showModal=true&manage_plan=true&tier=max&billing_cycle=monthly&reason=max_announcement')
    });
    closeReleaseNotes();
  });

  trackEvent('max_announcement_shown', {
    source: 'update_tab',
    offer_price_monthly: 14.99,
    regular_price_monthly: 19.99
  });

  gotItBtn.addEventListener('click', () => {
    trackEvent('max_announcement_dismissed', {
      source: 'update_tab'
    });
    closeReleaseNotes();
  });
}

async function configureDefaultReleaseNotes() {
  let version = null;
  try {
    version = chrome.runtime.getManifest().version;
    const badge = document.getElementById('releaseBadge');
    if (badge) {
      badge.textContent = `v${version}`;
    }
  } catch (error) {
    console.warn('[HaramMute] Failed to read release version:', error);
  }

  trackEvent('release_notes_shown', {
    source: 'update_tab',
    version
  });

  const result = await chrome.storage.local.get(['harammute-processing-mode']);
  if (result['harammute-processing-mode'] === 'local') {
    const tryAgainBtn = document.getElementById('tryAgainBtn');
    tryAgainBtn.style.display = 'inline-block';
    tryAgainBtn.addEventListener('click', () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL('onboarding.html?showLocalModal=true')
      });
      window.close();
    });
  }
}

(async () => {
  await initPostHog();

  const params = new URLSearchParams(window.location.search);
  const variant = params.get('variant');

  if (variant === 'max-announcement') {
    configureMaxAnnouncement();
    return;
  }

  await configureDefaultReleaseNotes();
})();
