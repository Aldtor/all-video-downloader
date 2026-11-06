document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy;
    const feedback = document.getElementById('copyFeedback');
    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = 'Copied to clipboard';
    } catch {
      feedback.textContent = `Copy this command: ${text}`;
    }
    window.setTimeout(() => { feedback.textContent = ''; }, 2200);
  });
});

const revealItems = document.querySelectorAll('.feature-card, .section-intro, .how-copy, .setup-card');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  revealItems.forEach((item) => {
    item.classList.add('reveal-ready');
    observer.observe(item);
  });
} else {
  revealItems.forEach((item) => item.classList.add('revealed'));
}
