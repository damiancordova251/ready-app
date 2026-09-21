import { elements } from "../../dom/elements.js";
import { t } from "../../i18n/i18n.js";
import { INSTALLATION_ID_STORAGE_KEY } from "../../constants/storageKeys.js";
import { deleteAllMyData } from "../../services/privacyApi.js";

// The Settings "Privacy & your data" section: shows this device's
// installation id (the only handle that identifies its records, so a user can
// quote it in an access request) and runs the delete-everything flow.
export function initPrivacyControls() {
  renderInstallationId();

  if (!elements.deleteDataButton) {
    return;
  }

  const modal = createConfirmModal();

  document.body.append(modal);
  elements.deleteDataButton.addEventListener("click", () => openModal(modal));
}

function renderInstallationId() {
  if (!elements.installationIdValue) {
    return;
  }

  elements.installationIdValue.textContent = getInstallationId() ?? "—";
}

function createConfirmModal() {
  const overlay = document.createElement("div");

  overlay.className = "share-modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="share-modal-backdrop"></div>
    <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="deleteDataModalTitle">
      <h2 id="deleteDataModalTitle" class="share-modal-title">${escapeHtml(t("settings.deleteDataConfirmTitle"))}</h2>
      <p class="share-modal-body">${escapeHtml(t("settings.deleteDataConfirmBody"))}</p>
      <p class="share-modal-message delete-data-message" aria-live="polite"></p>
      <div class="share-modal-actions">
        <button type="button" class="secondary-action delete-data-cancel">${escapeHtml(t("settings.deleteDataCancel"))}</button>
        <button type="button" class="primary-action destructive-action delete-data-confirm">${escapeHtml(t("settings.deleteDataConfirm"))}</button>
      </div>
    </div>
  `;

  overlay.querySelector(".delete-data-cancel").addEventListener("click", () => closeModal(overlay));
  overlay.querySelector(".share-modal-backdrop").addEventListener("click", () => closeModal(overlay));
  overlay.querySelector(".delete-data-confirm").addEventListener("click", () => handleConfirm(overlay));

  return overlay;
}

function openModal(modal) {
  modal.querySelector(".delete-data-message").textContent = "";
  modal.querySelector(".delete-data-confirm").disabled = false;
  modal.hidden = false;
}

function closeModal(modal) {
  modal.hidden = true;
}

async function handleConfirm(overlay) {
  const confirmButton = overlay.querySelector(".delete-data-confirm");
  const cancelButton = overlay.querySelector(".delete-data-cancel");
  const messageEl = overlay.querySelector(".delete-data-message");

  confirmButton.disabled = true;
  cancelButton.disabled = true;
  messageEl.textContent = t("settings.deleteDataWorking");

  try {
    await deleteAllMyData();
    messageEl.textContent = t("settings.deleteDataDone");

    // A full reload is the honest way to reflect a wiped device: every
    // feature module read its state from localStorage at boot, so leaving
    // the current page up would keep showing data that no longer exists.
    window.setTimeout(() => window.location.reload(), 1500);
  } catch (error) {
    messageEl.textContent = t("settings.deleteDataFailed");
    confirmButton.disabled = false;
    cancelButton.disabled = false;
  }
}

function getInstallationId() {
  try {
    return window.localStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
