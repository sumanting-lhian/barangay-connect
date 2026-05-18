// ── UTILS ─────────────────────────────────────────

function sanitize(str) {
  const el = document.createElement('div');
  el.textContent = String(str ?? '');
  return el.innerHTML;
}


// ── DATA ──────────────────────────────────────────

let concerns = [];
let nextId = 1;


// ── CORE ──────────────────────────────────────────

function addConcern(category, description, photoUrl) {

  const newConcern = {
    id: nextId,
    category: category,
    description: description,
    photoUrl: photoUrl,
    status: 'pending',
    submittedAt: new Date()
  };

  concerns.push(newConcern);
  nextId++;
}


// ── RENDER ────────────────────────────────────────

function renderConcerns() {
  const grid = document.getElementById('concernsGrid');

  if (concerns.length === 0) {
    grid.innerHTML = `
      <div class="concerns-empty">
        <div class="concerns-empty__icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
          </svg>
        </div>
        <p class="concerns-empty__text">No concerns submitted yet.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = concerns.map(concern => buildConcernCard(concern)).join('');
}


function buildConcernCard(concern) {

  const dateString = concern.submittedAt.toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const timeString = concern.submittedAt.toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit'
  });

  const cardClass = concern.status === 'resolved'
    ? 'concern-card concern-card--resolved'
    : 'concern-card concern-card--pending';

  const badgeClass = concern.status === 'resolved'
    ? 'concern-status-badge concern-status-badge--resolved'
    : 'concern-status-badge concern-status-badge--pending';

  const badgeLabel = concern.status === 'resolved'
    ? 'Resolved'
    : 'Pending';

  const photoSection = concern.photoUrl
    ? `<img src="${concern.photoUrl}" alt="Concern photo" class="concern-card__photo" />`
    : '';

  const resolveButton = concern.status === 'pending'
    ? `<button class="btn btn--outline btn--sm concern-resolve-btn"
         onclick="resolveConcern(${concern.id})">
         Mark as Resolved
       </button>`
    : '';

  return `
    <div class="${cardClass}">
      <div class="concern-card__meta">
        <span>${sanitize(concern.category)}</span>
        <span>·</span>
        <span>${dateString} · ${timeString}</span>
        <span>·</span>
        <span class="${badgeClass}">${badgeLabel}</span>
      </div>

      <p class="concern-card__desc">
        ${sanitize(concern.description)}
      </p>

      ${photoSection}

      ${resolveButton}
    </div>
  `;
}


// ── RESOLVE ───────────────────────────────────────

function resolveConcern(id) {
  const concern = concerns.find(c => c.id === id);

  if (!concern) return;

  concern.status = 'resolved';

  renderConcerns();
}


// ── REVIEW ────────────────────────────────────────

function populateReview() {

  const selectedBtn = document.querySelector(
    '.concern-grid .btn--selector.is-selected'
  );

  const category = selectedBtn
    ? selectedBtn.textContent.trim()
    : '—';

  const description = document
    .getElementById('concernDescription')
    .value
    .trim();

  const photoInput = document.getElementById('photoInput');

  const photoCount = photoInput.files.length;

  document.getElementById('reviewCategory').textContent =
    category;

  document.getElementById('reviewDescription').textContent =
    description || '—';

  document.getElementById('reviewPhotos').textContent =
    photoCount > 0
      ? photoCount + ' photo(s) attached'
      : 'No photos attached';
}


// ── SETUP ─────────────────────────────────────────

function setupForm() {

  const submitBtn = document.getElementById('concernSubmitBtn');

  const descInput = document.getElementById('concernDescription');

  const charCount = descInput
    .closest('.form-group')
    .querySelector('.char-count');


  descInput.addEventListener('input', function() {
    charCount.textContent =
      this.value.length + '/500 characters';
  });


  submitBtn.addEventListener('click', function() {

    const selectedBtn = document.querySelector(
      '.concern-grid .btn--selector.is-selected'
    );

    const category = selectedBtn
      ? selectedBtn.textContent.trim()
      : '';

    const description = descInput.value.trim();

    const photoInput = document.getElementById('photoInput');


    if (!category) {
      alert('Please select a category in step 1.');
      return;
    }

    if (!description) {
      alert('Please describe the concern in step 2.');
      return;
    }


    let photoUrl = null;

    if (photoInput.files.length > 0) {
      photoUrl = URL.createObjectURL(photoInput.files[0]);
    }


    addConcern(category, description, photoUrl);

    renderConcerns();


    // Reset form
    descInput.value = '';

    photoInput.value = '';

    charCount.textContent = '0/500 characters';


    document
      .querySelectorAll('.concern-grid .btn--selector')
      .forEach(btn => {
        btn.classList.remove('is-selected');
      });


    goToStep(1);
  });
}


// ── START ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  setupForm();
  renderConcerns();
});
