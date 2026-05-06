const RSS_URL = "https://athome.robocup.org/feed/";
const CORS_PROXY = "https://api.allorigins.win/get?url=";

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function stripHTML(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function excerpt(text, maxLen = 160) {
  const clean = stripHTML(text).trim();
  return clean.length > maxLen ? clean.slice(0, maxLen).replace(/\s+\S*$/, "") + "…" : clean;
}

function categoryTag(categories) {
  if (!categories || categories.length === 0) return "";
  const label = categories[0];
  return `<div class="news-card-tag">${label}</div>`;
}

async function load() {
  const grid = document.getElementById("news-grid");
  try {
    const res = await fetch(CORS_PROXY + encodeURIComponent(RSS_URL));
    const data = await res.json();
    const xml = new DOMParser().parseFromString(data.contents, "text/xml");
    const items = Array.from(xml.querySelectorAll("item"));

    if (items.length === 0) {
      grid.innerHTML = `<div class="news-loading">No posts found.</div>`;
      return;
    }

    grid.innerHTML = "";

    items.forEach((item, i) => {
      const title = item.querySelector("title")?.textContent || "Untitled";
      const link = item.querySelector("link")?.textContent || "#";
      const pubDate = item.querySelector("pubDate")?.textContent || "";
      const description = item.querySelector("description")?.textContent || "";
      const categories = Array.from(item.querySelectorAll("category")).map(c => c.textContent);

      const isFeatured = i === 0;
      const card = document.createElement("div");
      card.className = isFeatured ? "news-card news-card-featured" : "news-card";
      card.innerHTML = `
        ${categoryTag(categories)}
        <div class="news-card-title">
          <a href="${link}" target="_blank">${title}</a>
        </div>
        ${isFeatured ? `<p class="news-card-excerpt">${excerpt(description, 240)}</p>` : ""}
        <div class="news-card-date">${formatDate(pubDate)}</div>`;
      grid.appendChild(card);
    });

  } catch (err) {
    grid.innerHTML = `<div class="news-loading">
      Could not load posts. <a href="https://athome.robocup.org/" target="_blank" style="color:var(--accent);">Visit the website directly ↗</a>
    </div>`;
  }
}

load();
