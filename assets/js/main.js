async function loadComponent(id, file) {
  const element = document.getElementById(id);
  if (!element) return;

  try {
    const res = await fetch(file);
    const html = await res.text();
    element.innerHTML = html;
  } catch (err) {
    console.error(`Error loading ${file}:`, err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadComponent("navbar", "components/navbar.html");
  loadComponent("footer", "components/footer.html");
});
