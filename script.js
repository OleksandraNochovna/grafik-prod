(function () {
  "use strict";

  const DB_NAME = "produktywnosc_linia_czasu";
  const DB_VERSION = 2;
  const STORE_DAYS = "days";
  const STORE_ENTRIES = "entries";

  const COLORS = {
    productivity: "#fad51e",
    sleep: "#a6cff5",
    coffee: "#e82e00",
    energy: "#c92083",
    water: "#b7e1f7",
    sugar: "#f5ff87",
    calories: "#2ac93d",
    smoking: "#264f8c",
    walking: "#67758a",
    exercise: "#f2b55e"
  };

  const metrics = [
    { id: "productivity", name: "Produktywność", shortName: "Produktyw-\nność", color: COLORS.productivity, input: "range", min: 0, max: 6, unit: "", kind: "interval" },
    { id: "sleep", name: "Sen", color: COLORS.sleep, input: "sleep", min: 3, max: 11, unit: "h", kind: "sleep" },
    { id: "coffee", name: "Kawa", color: COLORS.coffee, input: "ml", min: 0, max: 1000, unit: "ml", kind: "interval" },
    { id: "energy", name: "Energetyki", color: COLORS.energy, input: "ml", min: 0, max: 1000, unit: "ml", kind: "interval" },
    { id: "water", name: "Woda", color: COLORS.water, lineColor: "#c1d4de", input: "ml", min: 0, max: 2200, unit: "ml", kind: "event", cumulative: true },
    { id: "sugar", name: "Cukier", color: COLORS.sugar, input: "grams", min: 0, max: 200, unit: "g", kind: "event" },
    { id: "calories", name: "Kalorie", color: COLORS.calories, lineColor: "#268c32", input: "kcal", min: 0, max: 2100, unit: "kcal", kind: "event", cumulative: true },
    { id: "smoking", name: "Palenie", color: COLORS.smoking, input: "duration", min: 0, max: 30, unit: "min", kind: "interval" },
    { id: "walking", name: "Spacer", color: COLORS.walking, input: "duration", min: 0, max: 120, unit: "min", kind: "interval" },
    { id: "exercise", name: "Sport", color: COLORS.exercise, input: "sport", min: 0, max: 120, unit: "min", kind: "interval" }
  ];

  const state = {
    db: null,
    day: null,
    entries: [],
    allDays: [],
    visible: Object.fromEntries(metrics.map((m) => [m.id, true])),
    zoom: 1,
    editingId: null,
    activeMetric: null,
    historySelectedDate: null,
    chartModel: null
  };

  const $ = (id) => document.getElementById(id);
  const metricById = (id) => metrics.find((m) => m.id === id);
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const pad = (n) => String(n).padStart(2, "0");

  function todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function addDaysIso(date, days) {
    const value = new Date(`${date}T12:00:00`);
    value.setDate(value.getDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_DAYS)) db.createObjectStore(STORE_DAYS, { keyPath: "date" });
        if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
          const store = db.createObjectStore(STORE_ENTRIES, { keyPath: "id" });
          store.createIndex("dayDate", "dayDate", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(store, mode);
      const objectStore = transaction.objectStore(store);
      let requestOrValue;
      try {
        requestOrValue = fn(objectStore);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(requestOrValue && requestOrValue.result !== undefined ? requestOrValue.result : requestOrValue);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function getAll(store) {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(store, "readonly");
      const req = transaction.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveDay(day) {
    const next = normalizeDay({ ...day, updatedAt: new Date().toISOString() });
    await tx(STORE_DAYS, "readwrite", (s) => s.put(next));
    return next;
  }

  async function saveEntry(entry) {
    entry.updatedAt = new Date().toISOString();
    await tx(STORE_ENTRIES, "readwrite", (s) => s.put(entry));
  }

  async function deleteEntry(id) {
    await tx(STORE_ENTRIES, "readwrite", (s) => s.delete(id));
  }

  function normalizeDay(day) {
    return {
      date: day.date,
      wakeTime: day.wakeTime || "07:00",
      bedTime: day.bedTime || day.sleepTime || "23:30",
      endTime: day.endTime || "23:59",
      createdAt: day.createdAt || new Date().toISOString(),
      updatedAt: day.updatedAt || new Date().toISOString()
    };
  }

  async function ensureDay(date) {
    let day = await tx(STORE_DAYS, "readonly", (s) => s.get(date));
    if (!day) {
      day = normalizeDay({ date });
      await saveDay(day);
    }
    return normalizeDay(day);
  }

  async function loadDay(date) {
    const day = await ensureDay(date || todayIso());
    const allEntries = await getAll(STORE_ENTRIES);
    state.day = day;
    state.entries = allEntries.filter((e) => e.dayDate === day.date).sort(sortEntries);
    state.allDays = (await getAll(STORE_DAYS)).map(normalizeDay).sort((a, b) => b.date.localeCompare(a.date));
    syncDayLabel();
    renderAll();
  }

  function sortEntries(a, b) {
    return entrySortKey(a).localeCompare(entrySortKey(b)) || a.metric.localeCompare(b.metric);
  }

  function entrySortKey(entry) {
    return entry.start || entry.time || "99:99";
  }

  function minutesFromTime(time) {
    const [h, m] = String(time || "00:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function displayTime(minute) {
    const normalized = ((Math.round(minute) % 1440) + 1440) % 1440;
    return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
  }

  function dayRange(day) {
    const start = minutesFromTime(day.wakeTime || "07:00");
    let end = minutesFromTime(day.endTime || "23:59");
    if (end <= start) end += 1440;
    const slotMinutes = 30;
    const slots = Math.max(1, Math.ceil((end - start) / slotMinutes));
    return { start, end, slotMinutes, slots };
  }

  function normalizeMinute(time, range) {
    let value = minutesFromTime(time);
    if (value < range.start) value += 1440;
    return value;
  }

  function slotBounds(range, index) {
    const a = range.start + index * range.slotMinutes;
    return { a, b: Math.min(range.end, a + range.slotMinutes) };
  }

  function minuteToSlot(minute, range) {
    if (minute < range.start || minute > range.end) return null;
    return Math.min(range.slots - 1, Math.max(0, Math.floor((minute - range.start) / range.slotMinutes)));
  }

  function rawDurationMinutes(startTime, endTime) {
    let start = minutesFromTime(startTime);
    let end = minutesFromTime(endTime);
    if (end <= start) end += 1440;
    return Math.max(0, end - start);
  }

  function durationMinutes(entry, range) {
    const start = normalizeMinute(entry.start, range);
    let end = normalizeMinute(entry.end, range);
    if (end <= start) end += 1440;
    return Math.max(0, end - start);
  }

  function overlapMinutes(entry, slotStart, slotEnd, range) {
    const start = normalizeMinute(entry.start, range);
    let end = normalizeMinute(entry.end, range);
    if (end <= start) end += 1440;
    return Math.max(0, Math.min(end, slotEnd) - Math.max(start, slotStart));
  }

  function roundToHalfHour(time) {
    const date = time || new Date();
    const total = date.getHours() * 60 + date.getMinutes();
    return displayTime(Math.round(total / 30) * 30);
  }

  function defaultMoment() {
    return state.day && state.day.date === todayIso() ? roundToHalfHour(new Date()) : (state.day?.wakeTime || "07:00");
  }

  function addMinutesToTime(time, minutes) {
    return displayTime(minutesFromTime(time) + minutes);
  }

  function formatDuration(minutes) {
    const safe = Math.max(0, Math.round(minutes || 0));
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    return `${h} h ${pad(m)} min`;
  }

  function iconSvg(metricId) {
    const common = 'viewBox="0 0 64 64" aria-hidden="true" focusable="false"';
    const icons = {
      productivity: `<svg ${common}><circle cx="32" cy="32" r="19"/><circle cx="24" cy="27" r="2"/><circle cx="40" cy="27" r="2"/><path d="M22 38c5 6 15 6 20 0"/></svg>`,
      sleep: `<svg ${common}><path d="M13 39h38"/><path d="M17 39V25h10c5 0 8 3 8 8v6"/><path d="M35 32h12c4 0 6 3 6 7"/></svg>`,
      coffee: `<svg ${common}><path d="M18 22h27v16a12 12 0 0 1-12 12h-3a12 12 0 0 1-12-12z"/><path d="M45 27h4a7 7 0 0 1 0 14h-4"/><path d="M24 14v4M32 12v5M40 14v4"/></svg>`,
      energy: `<svg ${common}><path d="M36 6 18 35h15l-5 23 19-31H32z"/></svg>`,
      water: `<svg ${common}><path d="M32 8c10 13 17 22 17 33a17 17 0 0 1-34 0c0-11 7-20 17-33z"/></svg>`,
      sugar: `<svg ${common}><path d="M18 25 32 14l14 11v18L32 54 18 43z"/><path d="M18 25 32 36l14-11"/></svg>`,
      calories: `<svg ${common}><path d="M33 7c8 9 16 18 16 31a17 17 0 0 1-34 0c0-8 4-14 9-20 0 7 5 10 9 10 4 0 8-4 0-21z"/></svg>`,
      smoking: `<svg ${common}><path d="M12 40h30v8H12z"/><path d="M47 40h5v8h-5z"/><path d="M35 20c7 0 10 4 10 10"/><path d="M43 13c7 3 10 8 9 15"/></svg>`,
      walking: `<svg ${common}><circle cx="34" cy="13" r="5"/><path d="M31 20 24 34l12 6 8 14"/><path d="M29 29 17 31"/><path d="M35 40 24 55"/></svg>`,
      exercise: `<svg ${common}><path d="M13 35h9"/><path d="M42 35h9"/><path d="M22 29v12"/><path d="M42 29v12"/><path d="M22 35h20"/></svg>`
    };
    return icons[metricId] || "";
  }

  function initMetricButtons() {
    $("metricGrid").innerHTML = metrics.map((m) => `
      <button class="metric-button" data-metric="${m.id}" style="border-color:${m.color};">
        <span class="metric-icon">${iconSvg(m.id)}</span>
        <span>${m.shortName || m.name}</span>
      </button>
    `).join("");
    document.querySelectorAll(".metric-button").forEach((button) => {
      button.addEventListener("click", () => openEntryDialog(button.dataset.metric));
    });
  }

  function initToggles() {
    // Produktywność jest zawsze widoczna, dlatego nie ma tu checkboxa do jej wyłączenia.
    const optionalMetrics = metrics.filter((m) => m.id !== "productivity");
    $("toggleRow").innerHTML = optionalMetrics.map((m) => `
      <label><input type="checkbox" data-toggle="${m.id}" checked> ${m.name}</label>
    `).join("");
    document.querySelectorAll("[data-toggle]").forEach((input) => {
      input.addEventListener("change", () => {
        state.visible[input.dataset.toggle] = input.checked;
        drawChart();
      });
    });
  }

  function syncDayLabel() {
    const text = state.day.date === todayIso() ? "Dzisiaj" : formatDate(state.day.date);
    $("todayLabel").textContent = text;
    $("historyDateInput").value = state.day.date;
  }

  function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    if (typeof modal.showModal === "function") {
      if (!modal.open) modal.showModal();
    } else {
      modal.classList.add("is-open");
    }
  }

  function closeModal(id) {
    const modal = $(id);
    if (!modal) return;
    if (typeof modal.close === "function" && modal.open) modal.close();
    modal.classList.remove("is-open");
  }

  function openEntryDialog(metricId, entry) {
    const metric = metricById(metricId);
    if (!metric) return;
    state.activeMetric = metricId;
    state.editingId = entry ? entry.id : null;
    $("dialogIcon").innerHTML = iconSvg(metric.id);
    $("dialogTitle").textContent = entry ? `Edytuj: ${metric.name}` : metric.name;
    $("dialogSubtitle").textContent = formatDate(state.day.date);
    $("deleteEntryBtn").hidden = !entry;
    $("newEntryBtn").hidden = !entry;
    $("entryFields").innerHTML = fieldsForMetric(metric, entry);
    bindDynamicFields();
    renderMetricEntryList(metricId);
    openModal("entryDialog");
  }

  function fieldsForMetric(metric, entry) {
    if (metric.kind === "event") {
      const time = entry?.time || defaultMoment();
      return `
        <label>Godzina<input name="time" type="time" step="60" value="${time}" required></label>
        <label>${eventValueLabel(metric)}<input name="value" type="number" min="0" step="1" value="${entry ? entry.value : defaultValue(metric)}" required></label>
      `;
    }

    if (metric.kind === "sleep") {
      const start = entry?.start || state.day.bedTime || "23:30";
      const end = entry?.end || state.day.wakeTime || "07:00";
      return `
        <label>Położyłam się<input name="start" type="time" step="60" value="${start}" required></label>
        <label>Obudziłam się<input name="end" type="time" step="60" value="${end}" required></label>
        <div class="calculated-box">Czas snu: <strong id="sleepDuration">${formatDuration(rawDurationMinutes(start, end))}</strong></div>
      `;
    }

    const start = entry?.start || defaultMoment();
    const end = entry?.end || addMinutesToTime(start, 30);
    let extra = "";
    if (metric.input === "range") {
      const value = entry ? Number(entry.value || 0) : 3;
      extra = `<label>Ocena od 0 do 6
        <div class="slider-row"><input name="value" type="range" min="0" max="6" step="1" value="${value}"><strong id="sliderValue">${value}</strong></div>
      </label>`;
    } else if (metric.input === "ml") {
      extra = `<label>Ilość ml<input name="value" type="number" min="1" step="1" value="${entry ? entry.value : defaultValue(metric)}" required></label>`;
    } else if (metric.input === "sport") {
      extra = `<label>Rodzaj aktywności<input name="activity" type="text" value="${entry ? escapeHtml(entry.activity || "") : ""}" placeholder="np. siłownia, rower, bieg"></label>`;
    }

    return `
      <label>Od<input name="start" type="time" step="60" value="${start}" required></label>
      <label>Do<input name="end" type="time" step="60" value="${end}" required></label>
      ${extra}
    `;
  }

  function eventValueLabel(metric) {
    if (metric.input === "grams") return "Ilość cukru (g)";
    if (metric.input === "kcal") return "Kalorie (kcal)";
    return "Ilość ml";
  }

  function defaultValue(metric) {
    if (metric.id === "coffee") return 250;
    if (metric.id === "energy") return 250;
    if (metric.id === "water") return 250;
    if (metric.id === "sugar") return 20;
    if (metric.id === "calories") return 500;
    return 1;
  }

  function bindDynamicFields() {
    const slider = document.querySelector('input[name="value"][type="range"]');
    if (slider) slider.addEventListener("input", () => $("sliderValue").textContent = slider.value);

    const start = document.querySelector('#entryFields input[name="start"]');
    const end = document.querySelector('#entryFields input[name="end"]');
    const output = $("sleepDuration");
    if (start && end && output && state.activeMetric === "sleep") {
      const update = () => output.textContent = formatDuration(rawDurationMinutes(start.value, end.value));
      start.addEventListener("input", update);
      end.addEventListener("input", update);
      update();
    }
  }

  async function saveEntryFromDialog(event) {
    event.preventDefault();
    const form = new FormData($("entryForm"));
    const metric = metricById(state.activeMetric);
    const existing = state.entries.find((e) => e.id === state.editingId);
    const entry = existing || { id: uid(), dayDate: state.day.date, metric: metric.id, createdAt: new Date().toISOString() };
    entry.metric = metric.id;
    entry.dayDate = state.day.date;

    if (metric.kind === "event") {
      entry.time = form.get("time");
      entry.value = Number(form.get("value"));
      delete entry.start;
      delete entry.end;
      delete entry.activity;
    } else {
      entry.start = form.get("start");
      entry.end = form.get("end");
      delete entry.time;
      if (metric.kind === "sleep") {
        entry.value = Number((rawDurationMinutes(entry.start, entry.end) / 60).toFixed(2));
        delete entry.activity;
        state.day.bedTime = entry.start;
        state.day.wakeTime = entry.end;
        state.day.endTime = "23:59";
        state.day = await saveDay(state.day);
      } else if (metric.input === "range") {
        entry.value = Number(form.get("value"));
        delete entry.activity;
      } else if (metric.input === "ml") {
        entry.value = Number(form.get("value"));
        delete entry.activity;
      } else if (metric.input === "sport") {
        entry.activity = String(form.get("activity") || "").trim();
        delete entry.value;
      } else {
        delete entry.value;
        delete entry.activity;
      }
    }

    await saveEntry(entry);
    await loadDay(state.day.date);
    openEntryDialog(metric.id);
  }

  async function removeEditingEntry() {
    if (!state.editingId) return;
    const metricId = state.activeMetric;
    const deleted = state.entries.find((entry) => entry.id === state.editingId);
    await deleteEntry(state.editingId);
    if (deleted?.metric === "sleep") await recalculateDayFromSleep(state.day.date);
    await loadDay(state.day.date);
    openEntryDialog(metricId);
  }

  async function recalculateDayFromSleep(dayDate) {
    const day = await ensureDay(dayDate);
    const all = await getAll(STORE_ENTRIES);
    const sleepEntries = all.filter((entry) => entry.dayDate === dayDate && entry.metric === "sleep").sort(sortEntries);
    if (sleepEntries.length) {
      const latest = sleepEntries[sleepEntries.length - 1];
      day.bedTime = latest.start;
      day.wakeTime = latest.end;
    } else {
      day.bedTime = "23:30";
      day.wakeTime = "07:00";
    }
    day.endTime = "23:59";
    await saveDay(day);
  }

  function renderMetricEntryList(metricId) {
    const list = state.entries.filter((entry) => entry.metric === metricId).sort(sortEntries);
    $("metricEntryList").innerHTML = list.length
      ? list.map((entry) => entryHtml(entry, state.day, "dialog")).join("")
      : `<div class="entry-empty">Nie ma jeszcze wpisów dla tego parametru w wybranym dniu.</div>`;
    document.querySelectorAll("[data-dialog-edit]").forEach((button) => {
      button.addEventListener("click", () => {
        const entry = state.entries.find((e) => e.id === button.dataset.dialogEdit);
        if (entry) openEntryDialog(entry.metric, entry);
      });
    });
  }

  function buildSeries(day, entries) {
    const range = dayRange(day);
    const labels = Array.from({ length: range.slots + 1 }, (_, i) => {
      const minute = i === range.slots ? range.end : range.start + i * range.slotMinutes;
      return displayTime(minute);
    });
    const productivity = Array.from({ length: range.slots }, () => null);

    entries.filter((e) => e.metric === "productivity").forEach((entry) => {
      for (let i = 0; i < range.slots; i++) {
        const { a, b } = slotBounds(range, i);
        if (overlapMinutes(entry, a, b, range) > 0) productivity[i] = Number(entry.value);
      }
    });

    const series = { labels, range, productivity, metrics: {} };

    metrics.filter((m) => m.id !== "productivity").forEach((metric) => {
      const values = Array.from({ length: range.slots }, () => metric.kind === "sleep" ? null : 0);
      const cumulative = Array.from({ length: range.slots }, () => 0);
      const metricEntries = entries.filter((e) => e.metric === metric.id);

      if (metric.kind === "sleep") {
        const totalHours = metricEntries.reduce((sum, entry) => sum + rawDurationMinutes(entry.start, entry.end) / 60, 0);
        if (totalHours > 0) values.fill(Number(totalHours.toFixed(2)));
      } else if (metric.kind === "event") {
        metricEntries.forEach((entry) => {
          const minute = normalizeMinute(entry.time, range);
          const index = minuteToSlot(minute, range);
          if (index !== null) values[index] += Number(entry.value || 0);
        });
      } else {
        metricEntries.forEach((entry) => {
          const totalDuration = Math.max(1, durationMinutes(entry, range));
          for (let i = 0; i < range.slots; i++) {
            const { a, b } = slotBounds(range, i);
            const overlap = overlapMinutes(entry, a, b, range);
            if (overlap <= 0) continue;
            if (metric.input === "ml") values[i] += Number(entry.value || 0);
            else if (metric.input === "range") values[i] = Number(entry.value || 0);
            else values[i] += Math.min(totalDuration, overlap);
          }
        });
      }

      let running = 0;
      values.forEach((value, i) => {
        running += Number(value || 0);
        cumulative[i] = running;
      });
      series.metrics[metric.id] = { values, cumulative };
    });

    return series;
  }

  function statSummary(day, entries) {
    const range = dayRange(day);
    const series = buildSeries(day, entries);
    const visibleProductivity = series.productivity.filter((value) => value !== null && !Number.isNaN(value));
    const productivityAvg = visibleProductivity.length ? visibleProductivity.reduce((a, b) => a + b, 0) / visibleProductivity.length : 0;

    const total = (metricId) => entries.filter((e) => e.metric === metricId).reduce((sum, entry) => {
      const metric = metricById(metricId);
      if (metric.kind === "event") return sum + Number(entry.value || 0);
      if (metric.input === "ml") return sum + Number(entry.value || 0);
      if (metric.kind === "sleep") return sum + rawDurationMinutes(entry.start, entry.end) / 60;
      return sum + durationMinutes(entry, range);
    }, 0);

    return {
      productivityAvg,
      sleepHours: total("sleep"),
      coffee: total("coffee"),
      energy: total("energy"),
      water: total("water"),
      sugar: total("sugar"),
      calories: total("calories"),
      smoking: total("smoking"),
      walking: total("walking"),
      exercise: total("exercise")
    };
  }

  function renderStats() {
    if (!$("dailyStats") || !$("periodStats")) return;
    const s = statSummary(state.day, state.entries);
    $("dailyStats").innerHTML = statsHtml(s);
    renderPeriodStats();
  }

  function statsHtml(s) {
    return [
      ["Śr. produktywność", s.productivityAvg ? s.productivityAvg.toFixed(2) : "0"],
      ["Sen", `${s.sleepHours.toFixed(1)} h`],
      ["Kawa", `${Math.round(s.coffee)} ml`],
      ["Energetyki", `${Math.round(s.energy)} ml`],
      ["Woda", `${Math.round(s.water)} ml`],
      ["Cukier", `${Math.round(s.sugar)} g`],
      ["Kalorie", `${Math.round(s.calories)} kcal`],
      ["Palenie", `${Math.round(s.smoking)} min`],
      ["Spacer", `${Math.round(s.walking)} min`],
      ["Sport", `${Math.round(s.exercise)} min`]
    ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
  }

  async function renderPeriodStats() {
    const days = (await getAll(STORE_DAYS)).map(normalizeDay);
    const entries = await getAll(STORE_ENTRIES);
    const current = new Date(`${state.day.date}T12:00:00`);
    const weekCut = new Date(current); weekCut.setDate(current.getDate() - 6);
    const monthCut = new Date(current); monthCut.setMonth(current.getMonth() - 1);
    const avgFor = (cut) => {
      const selected = days.filter((d) => new Date(`${d.date}T12:00:00`) >= cut);
      const values = selected.map((d) => statSummary(d, entries.filter((e) => e.dayDate === d.date)).productivityAvg).filter((v) => v > 0);
      if (!values.length) return 0;
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    if (!$("periodStats")) return;
    $("periodStats").innerHTML = [
      ["Dzienna", statSummary(state.day, state.entries).productivityAvg.toFixed(2)],
      ["Tygodniowa", avgFor(weekCut).toFixed(2)],
      ["Miesięczna", avgFor(monthCut).toFixed(2)]
    ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>Śr. produktywność ${label.toLowerCase()}</span></div>`).join("");
  }

  function renderAll() {
    drawChart();
  }

  function drawChart() {
    const canvas = $("mainChart");
    const ctx = canvas.getContext("2d");
    const wrapWidth = canvas.parentElement.clientWidth || 860;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1000, Math.round(wrapWidth * state.zoom * dpr));
    canvas.height = Math.round(560 * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const padL = 82, padR = 20, padT = 34, padB = 64;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, w, h);

    const series = buildSeries(state.day, state.entries);
    const range = series.range;
    const slots = range.slots;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const x = (i) => padL + (i / slots) * plotW;
    const y = (value, min, max) => padT + plotH - ((value - min) / Math.max(1, max - min)) * plotH;

    drawGrid(ctx, series, x, y, w, h, padL, padR, padT, padB, plotH);

    metrics.filter((m) => m.id !== "productivity" && state.visible[m.id]).forEach((metric) => {
      const data = series.metrics[metric.id];
      const max = Math.max(metric.max, ...data.values.map((v) => Number(v || 0)), ...(metric.cumulative ? data.cumulative : [0]));
      if (metric.kind === "sleep") drawLine(ctx, data.values, metric.color, x, y, metric.min, max, false, true);
      else if (metric.kind === "event") drawEvents(ctx, data.values, metric, x, y, padT, plotH, metric.min, max);
      else drawBars(ctx, data.values, metric, x, y, padT, plotH, metric.min, max);
      if (metric.cumulative) drawLine(ctx, data.cumulative, metric.lineColor || metric.color, x, y, metric.min, max, false, false);
    });

    drawProductivity(ctx, series.productivity, x, y);
    drawLegend(ctx, w, metrics.filter((m) => m.id === "productivity" || state.visible[m.id]));
    state.chartModel = { series, padL, padT, padB, padR, w, h, x };
  }

  function axisTime(minute) {
    const normalized = ((Math.round(minute) % 1440) + 1440) % 1440;
    return `${Math.floor(normalized / 60)}:${pad(normalized % 60)}`;
  }

  function drawGrid(ctx, series, x, y, w, h, padL, padR, padT, padB, plotH) {
    const { range } = series;
    ctx.strokeStyle = "#303030";
    ctx.lineWidth = 1;
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i <= range.slots; i++) {
      const minute = i === range.slots ? range.end : range.start + i * range.slotMinutes;
      const xx = x(i);
      const major = i === 0 || i === range.slots || minute % 60 === 0;
      ctx.globalAlpha = major ? 1 : 0.45;
      ctx.beginPath();
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, h - padB);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (major) {
        ctx.fillStyle = "#b8b8b8";
        ctx.fillText(axisTime(minute), xx, h - 40);
      }
    }

    const moods = ["😭", "😟", "🙁", "😐", "🙂", "😊", "😄"];
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let j = 0; j <= 6; j++) {
      const yy = y(j, 0, 6);
      ctx.strokeStyle = "#303030";
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillStyle = "#d8d8d8";
      ctx.font = "12px Arial";
      ctx.fillText(String(j), padL - 12, yy);
      ctx.font = "18px Arial";
      ctx.fillText(moods[j], padL - 32, yy);
    }
    ctx.fillStyle = COLORS.productivity;
    ctx.font = "12px Arial";
    ctx.textAlign = "left";
    ctx.fillText("Produktywność zawsze po lewej", padL, padT - 16);
  }

  function drawBars(ctx, values, metric, x, y, padT, plotH, min, max) {
    const barW = Math.max(3, x(1) - x(0) - 4);
    values.forEach((v, i) => {
      if (Number(v || 0) <= 0) return;
      const top = y(Math.min(max, Math.max(min, v)), min, max);
      ctx.fillStyle = metric.color;
      ctx.globalAlpha = 0.72;
      ctx.fillRect(x(i) + 2, top, barW, padT + plotH - top);
      ctx.globalAlpha = 1;
    });
  }

  function drawEvents(ctx, values, metric, x, y, padT, plotH, min, max) {
    values.forEach((v, i) => {
      if (Number(v || 0) <= 0) return;
      ctx.strokeStyle = metric.color;
      ctx.lineWidth = metric.id === "sugar" ? 3 : 4;
      ctx.beginPath();
      ctx.moveTo(x(i) + (x(1) - x(0)) / 2, padT + plotH);
      ctx.lineTo(x(i) + (x(1) - x(0)) / 2, y(Math.min(max, Math.max(min, v)), min, max));
      ctx.stroke();
    });
  }

  function drawLine(ctx, values, color, x, y, min, max, step, emphasize) {
    ctx.strokeStyle = color;
    ctx.lineWidth = emphasize ? 4 : 3;
    ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v === null || Number.isNaN(Number(v))) {
        started = false;
        return;
      }
      const xx = x(i + 0.5);
      const yy = y(Math.min(max, Math.max(min, Number(v))), min, max);
      if (!started) {
        ctx.moveTo(xx, yy);
        started = true;
      } else if (step) {
        const prev = values[i - 1];
        if (prev !== null && !Number.isNaN(Number(prev))) {
          ctx.lineTo(x(i), y(Math.min(max, Math.max(min, Number(prev))), min, max));
          ctx.lineTo(x(i), yy);
        } else {
          ctx.moveTo(xx, yy);
        }
      } else {
        ctx.lineTo(xx, yy);
      }
    });
    ctx.stroke();
  }

  function drawProductivity(ctx, values, x, y) {
    ctx.shadowColor = "rgba(250,213,30,.35)";
    ctx.shadowBlur = 8;
    drawLine(ctx, values, COLORS.productivity, x, y, 0, 6, true, true);
    ctx.shadowBlur = 0;
  }

  function drawLegend(ctx, w, list) {
    let left = 60;
    let top = 10;
    ctx.font = "12px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    list.forEach((m) => {
      const width = ctx.measureText(m.name).width + 42;
      if (left + width > w - 20) {
        left = 60;
        top += 16;
      }
      ctx.fillStyle = m.color;
      ctx.fillRect(left, top - 4, 12, 8);
      ctx.fillStyle = "#ddd";
      ctx.fillText(m.name, left + 18, top);
      left += width;
    });
  }

  function chartTooltip(event) {
    const model = state.chartModel;
    if (!model) return;
    const rect = $("mainChart").getBoundingClientRect();
    const xPos = event.clientX - rect.left;
    const slot = Math.max(0, Math.min(model.series.range.slots - 1, Math.floor((xPos - model.padL) / ((model.w - model.padL - model.padR) / model.series.range.slots))));
    const lines = [`<strong>${model.series.labels[slot]}-${model.series.labels[slot + 1]}</strong>`];
    const value = model.series.productivity[slot];
    if (value !== null) lines.push(`Produktywność: ${value}`);
    metrics.filter((m) => m.id !== "productivity" && state.visible[m.id]).forEach((m) => {
      const v = model.series.metrics[m.id].values[slot];
      if (v !== null && Number(v || 0) > 0) lines.push(`${m.name}: ${Number(v).toFixed(m.id === "sleep" ? 1 : 0)} ${m.unit}`);
    });
    if (lines.length === 1) lines.push("Brak wpisów w tym czasie");
    const tip = $("tooltip");
    tip.innerHTML = lines.join("<br>");
    tip.style.left = `${Math.min(rect.width - 270, Math.max(8, event.clientX - rect.left + 14))}px`;
    tip.style.top = `${Math.max(8, event.clientY - rect.top - 16)}px`;
    tip.hidden = false;
  }

  function renderHistory() {
    state.historySelectedDate = state.day.date;
    $("historyDateInput").value = state.day.date;
    $("historyList").innerHTML = state.allDays.length
      ? state.allDays.map((day) => `<button class="history-item${day.date === state.day.date ? " active" : ""}" data-day="${day.date}">${formatDate(day.date)}<br><small>Oś dnia: ${day.wakeTime} - ${day.endTime}</small></button>`).join("")
      : "<p>Brak zapisanych dni.</p>";
    document.querySelectorAll("[data-day]").forEach((button) => {
      button.addEventListener("click", () => showHistoryDay(button.dataset.day));
    });
    showHistoryDay(state.historySelectedDate);
  }

  async function showHistoryDay(date) {
    state.historySelectedDate = date;
    document.querySelectorAll("[data-day]").forEach((button) => button.classList.toggle("active", button.dataset.day === date));
    const days = (await getAll(STORE_DAYS)).map(normalizeDay);
    const entries = await getAll(STORE_ENTRIES);
    const day = days.find((d) => d.date === date) || normalizeDay({ date });
    const dayEntries = entries.filter((e) => e.dayDate === date).sort(sortEntries);
    $("historyTitle").textContent = formatDate(date);
    $("openSelectedHistoryDayBtn").hidden = false;
    $("historyStats").innerHTML = statsHtml(statSummary(day, dayEntries));
    $("entryList").innerHTML = dayEntries.map((e) => entryHtml(e, day, "history")).join("") || "<p>Brak wpisów.</p>";
    document.querySelectorAll("[data-history-edit]").forEach((button) => {
      button.addEventListener("click", async () => {
        const entry = dayEntries.find((e) => e.id === button.dataset.historyEdit);
        if (!entry) return;
        closeModal("historyDialog");
        await loadDay(entry.dayDate);
        openEntryDialog(entry.metric, entry);
      });
    });
  }

  function entryHtml(entry, day, place) {
    const metric = metricById(entry.metric);
    const attr = place === "history" ? `data-history-edit="${entry.id}"` : `data-dialog-edit="${entry.id}"`;
    const detail = entryDetail(entry, day);
    return `<button type="button" class="entry-item" ${attr}><span><span class="entry-icon">${iconSvg(metric.id)}</span> ${metric.name}<br><small>${escapeHtml(detail)}</small></span><small>Edytuj</small></button>`;
  }

  function entryDetail(entry, day) {
    const metric = metricById(entry.metric);
    if (metric.kind === "event") return `${entry.time}, ${entry.value} ${metric.unit}`;
    if (metric.kind === "sleep") return `${entry.start}-${entry.end}, ${formatDuration(rawDurationMinutes(entry.start, entry.end))}`;
    if (metric.input === "range") return `${entry.start}-${entry.end}, ocena ${entry.value}/6`;
    if (metric.input === "ml") return `${entry.start}-${entry.end}, ${entry.value} ${metric.unit}`;
    if (metric.input === "sport") {
      const activity = entry.activity ? `, ${entry.activity}` : "";
      return `${entry.start}-${entry.end}, ${formatDuration(durationMinutes(entry, dayRange(day)))}${activity}`;
    }
    return `${entry.start}-${entry.end}, ${formatDuration(durationMinutes(entry, dayRange(day)))}`;
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat("pl-PL", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  }

  async function exportJson() {
    const data = { version: 2, exportedAt: new Date().toISOString(), days: await getAll(STORE_DAYS), entries: await getAll(STORE_ENTRIES) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(blob, `produktywnosc-kopia-${todayIso()}.json`);
  }

  async function importJsonFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const days = Array.isArray(data.days) ? data.days : [];
      const entries = Array.isArray(data.entries) ? data.entries : [];
      for (const day of days) await saveDay(normalizeDay(day));
      const existing = new Set((await getAll(STORE_ENTRIES)).map((e) => e.id));
      for (const entry of entries) {
        const next = { ...entry };
        if (existing.has(next.id)) next.id = uid();
        await saveEntry(next);
      }
      await loadDay(state.day.date);
      alert("Import zakończony. Dane zostały scalone.");
    } catch (error) {
      console.error(error);
      alert("Nie udało się zaimportować pliku JSON.");
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportPng() {
    drawChart();
    $("mainChart").toBlob((blob) => downloadBlob(blob, `wykres-${state.day.date}.png`), "image/png", 1);
  }

  function exportPdf() {
    drawChart();
    const blob = canvasToPdfBlob($("mainChart"));
    downloadBlob(blob, `wykres-${state.day.date}.pdf`);
  }

  function canvasToPdfBlob(canvas) {
    const jpegData = canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    const imageBytes = base64ToBytes(jpegData);
    const pageW = 841.89;
    const pageH = 595.28;
    const margin = 22;
    let imgW = pageW - margin * 2;
    let imgH = imgW * (canvas.height / canvas.width);
    if (imgH > pageH - margin * 2) {
      imgH = pageH - margin * 2;
      imgW = imgH * (canvas.width / canvas.height);
    }
    const imgX = (pageW - imgW) / 2;
    const imgY = (pageH - imgH) / 2;
    const content = `q\n${imgW.toFixed(2)} 0 0 ${imgH.toFixed(2)} ${imgX.toFixed(2)} ${imgY.toFixed(2)} cm\n/Im0 Do\nQ\n`;

    const encoder = new TextEncoder();
    const parts = [];
    const offsets = [0];
    let length = 0;
    const addText = (text) => {
      const bytes = encoder.encode(text);
      parts.push(bytes);
      length += bytes.length;
    };
    const addBytes = (bytes) => {
      parts.push(bytes);
      length += bytes.length;
    };
    const mark = () => offsets.push(length);

    addText("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    mark(); addText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    mark(); addText("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    mark(); addText(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`);
    mark(); addText(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`);
    addBytes(imageBytes); addText("\nendstream\nendobj\n");
    mark(); addText(`5 0 obj\n<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
    const xrefStart = length;
    addText(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

    const output = new Uint8Array(length);
    let cursor = 0;
    parts.forEach((part) => {
      output.set(part, cursor);
      cursor += part.length;
    });
    return new Blob([output], { type: "application/pdf" });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bindEvents() {
    $("entryForm").addEventListener("submit", saveEntryFromDialog);
    $("deleteEntryBtn").addEventListener("click", removeEditingEntry);
    $("newEntryBtn").addEventListener("click", () => openEntryDialog(state.activeMetric));
    $("cancelEntryBtn").addEventListener("click", () => closeModal("entryDialog"));

    $("historyBtn").addEventListener("click", () => { renderHistory(); openModal("historyDialog"); });
    $("closeHistoryBtn").addEventListener("click", () => closeModal("historyDialog"));
    $("openHistoryDateBtn").addEventListener("click", async () => {
      const date = $("historyDateInput").value || todayIso();
      closeModal("historyDialog");
      await loadDay(date);
    });
    $("openSelectedHistoryDayBtn").addEventListener("click", async () => {
      if (!state.historySelectedDate) return;
      closeModal("historyDialog");
      await loadDay(state.historySelectedDate);
    });

    $("backupBtn").addEventListener("click", () => openModal("backupDialog"));
    $("closeBackupBtn").addEventListener("click", () => closeModal("backupDialog"));
    $("exportJsonBtn").addEventListener("click", exportJson);
    $("importJsonInput").addEventListener("change", (event) => event.target.files[0] && importJsonFile(event.target.files[0]));

    $("exportPdfBtn").addEventListener("click", exportPdf);
    $("mainChart").addEventListener("mousemove", chartTooltip);
    $("mainChart").addEventListener("mouseleave", () => $("tooltip").hidden = true);
    window.addEventListener("resize", drawChart);
  }

  async function init() {
    if (!window.indexedDB) throw new Error("Brak IndexedDB");
    state.db = await openDb();
    initMetricButtons();
    initToggles();
    bindEvents();
    await loadDay(todayIso());
  }

  init().catch((error) => {
    console.error(error);
    alert("Nie udało się uruchomić strony. Sprawdź, czy przeglądarka obsługuje bazę IndexedDB.");
  });
}());
