// kiosk /enroll 画面の「写真からの登録申請を承認する」パネル (職員専用)。
//
// kiosk.ts の HTML/スクリプトが 1 ファイルで肥大化するため、審査パネルの
// マークアップとスクリプトをここへ分ける。kiosk.ts 側は本文へ差し込むだけ。
//
// 表示範囲 (spec/feature/face-photo-seeded-enrollment.md §4):
//   写真を出すのはこのパネル (= 職員がパスキー認証したあとの承認画面) だけ。
//   出席確認の一般画面には出さない。写真は fetch でその都度取得し、
//   表示を終えたら objectURL を revoke してブラウザにも残さない。

export const REVIEW_PANEL_HTML = `
  <section id="review-panel" hidden>
    <h2>写真からの登録申請を承認</h2>
    <p id="review-status"></p>
    <button id="review-load">審査待ちの一覧を取得</button>
    <ul id="review-list"></ul>
    <div id="review-detail" hidden>
      <p id="review-subject"></p>
      <img id="review-photo" alt="申請された顔写真" width="240">
      <fieldset>
        <legend>承認方法</legend>
        <label><input type="radio" name="review-mode" value="reenroll" checked> 追加で撮影して登録し直す（推奨）</label>
        <label><input type="radio" name="review-mode" value="promote-photo"> 写真からの登録をそのまま承認する</label>
      </fieldset>
      <label>生徒認証コード（撮り直しの同意記録に必要） <input id="review-student-code" type="password" autocomplete="off" spellcheck="false"></label>
      <button id="review-approve">承認</button>
      <div id="review-consent" hidden>
        <p id="review-consent-text"></p>
        <label><input id="review-consent-accepted" type="checkbox"> 生徒本人が内容を理解し、同意しました</label>
        <button id="review-begin-capture" disabled>撮影を開始</button>
      </div>
      <p id="review-shots"></p>
      <button id="review-capture" disabled>このポーズを撮影</button>
      <label>却下理由（必須） <input id="review-reason" autocomplete="off"></label>
      <button id="review-reject" disabled>却下</button>
    </div>
  </section>`;

export const REVIEW_PANEL_SCRIPT = `
const reviewPanel = document.querySelector('#review-panel');
const reviewStatus = document.querySelector('#review-status');
const reviewList = document.querySelector('#review-list');
const reviewDetail = document.querySelector('#review-detail');
const reviewSubject = document.querySelector('#review-subject');
const reviewPhoto = document.querySelector('#review-photo');
const reviewApprove = document.querySelector('#review-approve');
const reviewStudentCode = document.querySelector('#review-student-code');
const reviewConsent = document.querySelector('#review-consent');
const reviewConsentText = document.querySelector('#review-consent-text');
const reviewConsentAccepted = document.querySelector('#review-consent-accepted');
const reviewBeginCapture = document.querySelector('#review-begin-capture');
const reviewShots = document.querySelector('#review-shots');
const reviewCapture = document.querySelector('#review-capture');
const reviewReason = document.querySelector('#review-reason');
const reviewReject = document.querySelector('#review-reject');
let reviewUserId;
let reviewEnrollId;
let reviewPhotoUrl;
let reviewStream;
let reviewShotsRequired = 6;

function reviewHeaders(extra) {
  return Object.assign({ 'x-ostiarius-staff': staffSession }, extra || {});
}

function releaseReviewPhoto() {
  if (reviewPhotoUrl) URL.revokeObjectURL(reviewPhotoUrl);
  reviewPhotoUrl = undefined;
  reviewPhoto.removeAttribute('src');
}

function stopReviewCapture() {
  if (reviewStream) reviewStream.getTracks().forEach((track) => track.stop());
  reviewStream = undefined;
  reviewCapture.disabled = true;
}

async function loadReviewCandidates() {
  if (!staffSession) { reviewStatus.textContent = '先に職員パスキーで認証してください。'; return; }
  const response = await fetch('/identity/review/candidates', { headers: reviewHeaders() });
  if (!response.ok) { reviewStatus.textContent = '審査待ちの一覧を取得できません。'; return; }
  const result = await response.json();
  reviewList.replaceChildren();
  for (const candidate of result.candidates) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = candidate.hint;
    button.onclick = () => { void openReviewCandidate(candidate); };
    item.appendChild(button);
    reviewList.appendChild(item);
  }
  reviewStatus.textContent = '審査待ちの候補: ' + result.candidates.length + ' 名';
}

async function openReviewCandidate(candidate) {
  releaseReviewPhoto();
  stopReviewCapture();
  reviewUserId = candidate.userId;
  reviewEnrollId = undefined;
  reviewDetail.hidden = false;
  reviewConsent.hidden = true;
  reviewShots.textContent = '';
  reviewReason.value = '';
  reviewStudentCode.value = '';
  reviewReject.disabled = true;
  reviewSubject.textContent = candidate.hint;
  const response = await fetch('/identity/review/photo/' + encodeURIComponent(candidate.userId), { headers: reviewHeaders() });
  if (response.status === 404) { reviewStatus.textContent = '未登録（写真の申請はありません）。'; return; }
  if (!response.ok) { reviewStatus.textContent = '写真を取得できません。'; return; }
  reviewPhotoUrl = URL.createObjectURL(await response.blob());
  reviewPhoto.src = reviewPhotoUrl;
  reviewStatus.textContent = '審査待ち。目の前の本人と写真を照合してください。';
}

function selectedReviewMode() {
  const checked = document.querySelector('input[name="review-mode"]:checked');
  return checked ? checked.value : 'reenroll';
}

async function approveReview() {
  if (!reviewUserId || !staffSession) return;
  if (selectedReviewMode() === 'reenroll' && !reviewEnrollId) {
    const studentAuthCode = reviewStudentCode.value.trim();
    if (!studentAuthCode) { reviewStatus.textContent = '生徒認証コードを入力してください。'; return; }
    const started = await fetch('/identity/review/reenroll/start', {
      method: 'POST', headers: reviewHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ userId: reviewUserId, studentAuthCode }),
    });
    if (!started.ok) { reviewStatus.textContent = '撮り直しを開始できません。生徒認証コードを確認してください。'; return; }
    reviewStudentCode.value = '';
    const session = await started.json();
    reviewEnrollId = session.enrollId;
    reviewShotsRequired = session.shots.required;
    reviewConsentText.textContent = session.consent.text;
    reviewConsent.hidden = false;
    reviewStatus.textContent = '生徒本人に同意内容を確認してもらってください。';
    return;
  }
  await submitReviewApproval();
}

async function submitReviewApproval() {
  const payload = { userId: reviewUserId, mode: selectedReviewMode(), enrollId: reviewEnrollId };
  const response = await fetch('/identity/review/approve', {
    method: 'POST', headers: reviewHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(payload),
  });
  if (!response.ok) { reviewStatus.textContent = '承認できませんでした。もう一度お試しください。'; return; }
  releaseReviewPhoto();
  stopReviewCapture();
  reviewDetail.hidden = true;
  reviewEnrollId = undefined;
  reviewStatus.textContent = '承認しました。出席照合に反映されます。';
  await loadReviewCandidates();
}

async function beginReviewCapture() {
  if (!reviewEnrollId || !reviewConsentAccepted.checked) return;
  const consented = await fetch('/identity/enroll/consent', {
    method: 'POST', headers: reviewHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ enrollId: reviewEnrollId, accepted: true }),
  });
  if (!consented.ok) { reviewStatus.textContent = '同意を記録できません。'; return; }
  reviewStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.srcObject = reviewStream; video.hidden = false;
  reviewBeginCapture.disabled = true;
  reviewCapture.disabled = false;
  reviewShots.textContent = '正面を向いて、撮影してください（0/' + reviewShotsRequired + '）。';
}

async function captureReviewShot() {
  if (!reviewEnrollId || !video.videoWidth) return;
  reviewCapture.disabled = true;
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .8));
  if (!frame) { reviewCapture.disabled = false; return; }
  const form = new FormData(); form.set('enrollId', reviewEnrollId); form.set('frame', frame, 'frame.jpg');
  const response = await fetch('/identity/enroll/frame', { method: 'POST', headers: reviewHeaders(), body: form });
  if (!response.ok) { reviewShots.textContent = '撮影に失敗しました。もう一度お試しください。'; reviewCapture.disabled = false; return; }
  const result = await response.json();
  if (!result.accepted) { reviewShots.textContent = '品質を確認できません。明るい場所で静止して、もう一度撮影してください。'; reviewCapture.disabled = false; return; }
  if (result.shotsDone < result.shotsRequired) {
    reviewShots.textContent = enrollmentPoses[result.shotsDone] + ' のポーズを撮影してください（' + result.shotsDone + '/' + result.shotsRequired + '）。';
    reviewCapture.disabled = false; return;
  }
  reviewShots.textContent = '撮影が完了しました。承認を送信しています。';
  await submitReviewApproval();
}

async function rejectReview() {
  if (!reviewUserId || !reviewReason.value.trim()) return;
  const response = await fetch('/identity/review/reject', {
    method: 'POST', headers: reviewHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ userId: reviewUserId, reason: reviewReason.value.trim() }),
  });
  if (!response.ok) { reviewStatus.textContent = '却下できませんでした。'; return; }
  releaseReviewPhoto();
  stopReviewCapture();
  reviewDetail.hidden = true;
  reviewStatus.textContent = '却下しました。写真と申請は削除されました。';
  await loadReviewCandidates();
}

document.querySelector('#review').onclick = () => {
  reviewPanel.hidden = false; enrollPanel.hidden = false; qr.replaceChildren(); stopPolling();
  reviewStatus.textContent = staffSession ? '審査待ちの一覧を取得してください。' : '先に職員パスキーで認証してください。';
};
document.querySelector('#review-load').onclick = () => { void loadReviewCandidates(); };
reviewApprove.onclick = () => { void approveReview(); };
reviewConsentAccepted.onchange = () => { reviewBeginCapture.disabled = !reviewConsentAccepted.checked; };
reviewBeginCapture.onclick = () => { void beginReviewCapture(); };
reviewCapture.onclick = () => { void captureReviewShot(); };
// 理由が空のあいだは却下ボタンを押せない (理由必須)。
reviewReason.oninput = () => { reviewReject.disabled = !reviewReason.value.trim(); };
reviewReject.onclick = () => { void rejectReview(); };
`;
