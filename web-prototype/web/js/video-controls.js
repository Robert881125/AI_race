export function parseVideoTime(value) {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : null;
  }
  if (!/^\d+(?::[0-5]\d){1,2}(?:\.\d+)?$/.test(text)) return null;
  const seconds = text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? seconds : null;
}

export function formatVideoTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const ticks = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(ticks / 600);
  const rest = (ticks % 600 / 10).toFixed(1).padStart(4, '0');
  const hours = Math.floor(minutes / 60);
  const mins = String(hours ? minutes % 60 : minutes).padStart(2, '0');
  return hours ? hours + ':' + mins + ':' + rest : mins + ':' + rest;
}

export function bindVideoControls(video, controls, onSeek) {
  const get = (id) => controls.querySelector('#' + id);
  const play = get('play');
  const timeline = get('video-timeline');
  const jump = get('jump-amount');
  const start = get('video-start');
  const message = get('video-control-msg');
  let scrubbing = false;

  function update() {
    timeline.max = Number.isFinite(video.duration) ? video.duration : 0;
    if (!scrubbing) timeline.value = video.currentTime;
    const current = formatVideoTime(video.currentTime);
    const total = formatVideoTime(video.duration);
    if (!scrubbing) timeline.setAttribute('aria-valuetext', current + ' / ' + total);
    get('time').textContent = current + ' / ' + total;
    play.textContent = video.paused ? '播放' : '暫停';
  }

  function seek(seconds) {
    if (!Number.isFinite(video.duration)) return false;
    video.currentTime = Math.max(0, Math.min(video.duration, seconds));
    update();
    return true;
  }

  function playVideo() {
    message.textContent = '';
    void video.play().catch(() => { message.textContent = '影片無法播放，請確認格式後重新選擇。'; });
  }

  play.addEventListener('click', () => { if (video.paused) playVideo(); else video.pause(); });
  for (const [id, direction] of [['back', -1], ['fwd', 1]]) {
    get(id).addEventListener('click', () => {
      video.pause();
      seek(video.currentTime + direction * Number(jump.value));
    });
  }
  timeline.addEventListener('input', () => {
    scrubbing = true;
    video.pause();
    const position = Number(timeline.value);
    timeline.setAttribute('aria-valuetext', formatVideoTime(position));
  });
  timeline.addEventListener('change', () => {
    const position = Number(timeline.value);
    scrubbing = false;
    video.pause();
    seek(position);
  });
  timeline.addEventListener('blur', () => { scrubbing = false; update(); });
  get('video-start-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const seconds = parseVideoTime(start.value);
    if (seconds === null || seconds >= video.duration || !seek(seconds)) {
      message.textContent = '請輸入影片範圍內的時間，例如 85 或 1:25。';
      return;
    }
    playVideo();
  });
  video.addEventListener('seeking', () => { if (!controls.hidden) onSeek(); });
  for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'durationchange', 'ended']) {
    video.addEventListener(event, () => { if (!controls.hidden) update(); });
  }
  return {
    reset() {
      scrubbing = false;
      start.value = '';
      message.textContent = '';
      update();
    },
  };
}
