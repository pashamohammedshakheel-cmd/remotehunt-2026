// ============================================================
// REMOTEHUNT 2026 - PRODUCTION SERVER
// Free Domain + Auto Deploy Ready
// ============================================================
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'remotehunt_2026_secret_key_change_me';
const cache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down!' }
});
app.use('/api/', limiter);

// ============================================================
// IN-MEMORY DATABASE
// ============================================================
class DB {
  constructor() {
    this.users     = new Map();
    this.apps      = new Map();
    this.saved     = new Map();
    this.resumes   = new Map();
    this.alerts    = new Map();
    this.prefs     = new Map();
    this.notifs    = new Map();
  }

  // ── Users ──
  createUser(d) {
    const u = {
      ...d,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      preferences: {
        remote_only: true,
        usa_only: false,
        exclude_leadership: true,
        exclude_staffing: true,
        salary_min: null,
        skills: [],
        preferred_titles: [],
        excluded_keywords: [],
        favorite_companies: [],
        employment_type: '',
        experience_level: '',
        date_posted: 'week',
        industry: ''
      }
    };
    this.users.set(u.id, u);
    return u;
  }
  findEmail(email) {
    return [...this.users.values()].find(u => u.email === email?.toLowerCase());
  }
  findId(id) { return this.users.get(id); }
  updateUser(id, data) {
    const u = this.users.get(id);
    if (!u) return null;
    const updated = { ...u, ...data, updatedAt: new Date().toISOString() };
    this.users.set(id, updated);
    return updated;
  }

  // ── Applications ──
  addApp(d) {
    const a = { ...d, id: uuidv4(), createdAt: new Date().toISOString() };
    this.apps.set(a.id, a);
    return a;
  }
  userApps(uid) {
    return [...this.apps.values()]
      .filter(a => a.userId === uid)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  updateApp(id, data) {
    const a = this.apps.get(id);
    if (!a) return null;
    const updated = { ...a, ...data, updatedAt: new Date().toISOString() };
    this.apps.set(id, updated);
    return updated;
  }
  deleteApp(id) { this.apps.delete(id); }

  // ── Saved Jobs ──
  saveJob(uid, job) {
    const key = `${uid}_${job.id}`;
    if (this.saved.has(key)) return false;
    this.saved.set(key, {
      id: uuidv4(), userId: uid, job,
      savedAt: new Date().toISOString()
    });
    return true;
  }
  unsaveJob(uid, jobId) { this.saved.delete(`${uid}_${jobId}`); }
  getSaved(uid) {
    return [...this.saved.values()]
      .filter(s => s.userId === uid)
      .map(s => s.job);
  }
  isSaved(uid, jobId) { return this.saved.has(`${uid}_${jobId}`); }

  // ── Resumes ──
  saveResume(uid, data) {
    const r = { ...data, id: uuidv4(), userId: uid, createdAt: new Date().toISOString() };
    const list = this.resumes.get(uid) || [];
    list.unshift(r);
    this.resumes.set(uid, list.slice(0, 10));
    return r;
  }
  getResumes(uid) { return this.resumes.get(uid) || []; }

  // ── Job Alerts ──
  addAlert(uid, data) {
    const a = { ...data, id: uuidv4(), userId: uid, createdAt: new Date().toISOString() };
    const list = this.alerts.get(uid) || [];
    list.push(a);
    this.alerts.set(uid, list);
    return a;
  }
  getAlerts(uid) { return this.alerts.get(uid) || []; }
  deleteAlert(uid, id) {
    const list = (this.alerts.get(uid) || []).filter(a => a.id !== id);
    this.alerts.set(uid, list);
  }

  // ── Notifications ──
  addNotif(uid, data) {
    const list = this.notifs.get(uid) || [];
    list.unshift({ ...data, id: uuidv4(), read: false, createdAt: new Date().toISOString() });
    this.notifs.set(uid, list.slice(0, 50));
  }
  getNotifs(uid) { return this.notifs.get(uid) || []; }
  markRead(uid, id) {
    const list = (this.notifs.get(uid) || []).map(n =>
      n.id === id ? { ...n, read: true } : n
    );
    this.notifs.set(uid, list);
  }
  markAllRead(uid) {
    const list = (this.notifs.get(uid) || []).map(n => ({ ...n, read: true }));
    this.notifs.set(uid, list);
  }
}

const db = new DB();

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = db.findId(decoded.userId);
    if (!req.user) return res.status(401).json({ success: false, error: 'User not found' });
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

function optAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      req.user = db.findId(d.userId);
    } catch {}
  }
  next();
}

// ============================================================
// JOB AGGREGATOR - 6 FREE SOURCES
// ============================================================
class JobAggregator {

  async fetch(filters) {
    const key = `jobs_${JSON.stringify(filters)}`;
    const hit = cache.get(key);
    if (hit) { console.log('📦 Cache hit'); return hit; }

    console.log('🔍 Fetching live jobs...');

    const [remoteok, remotive, themuse,
           arbeitnow, findwork, jobicy] = await Promise.allSettled([
      this.remoteok(filters),
      this.remotive(filters),
      this.themuse(filters),
      this.arbeitnow(filters),
      this.findwork(filters),
      this.jobicy(filters)
    ]);

    let all = [];
    const stats = [];

    const push = (r, name) => {
      const jobs = r.status === 'fulfilled' ? (r.value || []) : [];
      all = all.concat(jobs);
      stats.push({ name, count: jobs.length, ok: r.status === 'fulfilled' });
    };

    push(remoteok,  'RemoteOK');
    push(remotive,  'Remotive');
    push(themuse,   'The Muse');
    push(arbeitnow, 'Arbeitnow');
    push(findwork,  'Findwork');
    push(jobicy,    'Jobicy');

    all = this.tag(all);
    all = this.filter(all, filters);
    all = this.dedupe(all);
    all = this.score(all, filters);
    all = this.sort(all, filters.sort);

    const result = { jobs: all, total: all.length, stats };
    cache.set(key, result);

    console.log(`✅ ${all.length} jobs from ${stats.filter(s=>s.ok).length}/6 sources`);
    return result;
  }

  // ── Source: RemoteOK ──
  async remoteok() {
    const r = await axios.get('https://remoteok.com/api', {
      headers: { 'User-Agent': 'RemoteHunt/2.0' },
      timeout: 12000
    });
    return (r.data || []).slice(1).map(j => ({
      id: `rok_${j.id}`,
      title: j.position || '',
      company: j.company || '',
      logo: j.company_logo || null,
      location: 'Remote',
      description: (j.description || '').replace(/<[^>]*>/g, ''),
      salary_raw: j.salary_max ? `$${j.salary_min||0}k - $${j.salary_max}k/yr` : null,
      salary_min: j.salary_min ? j.salary_min * 1000 : null,
      salary_max: j.salary_max ? j.salary_max * 1000 : null,
      url: j.url || `https://remoteok.com/l/${j.slug}`,
      apply_url: j.apply_url || j.url,
      source: 'RemoteOK',
      source_icon: '🌍',
      remote: true,
      skills: (j.tags || []).map(t => t.toLowerCase()),
      employment_type: 'Full-time',
      posted_date: j.date ? new Date(j.date * 1000).toISOString() : new Date().toISOString(),
      views: j.views || 0,
      applicants: j.applicants || 0
    }));
  }

  // ── Source: Remotive ──
  async remotive() {
    const r = await axios.get('https://remotive.com/api/remote-jobs', {
      params: { limit: 100 },
      timeout: 12000
    });
    return (r.data.jobs || []).map(j => ({
      id: `rem_${j.id}`,
      title: j.title || '',
      company: j.company_name || '',
      logo: j.company_logo || null,
      location: 'Remote',
      description: (j.description || '').replace(/<[^>]*>/g, ''),
      salary_raw: j.salary || null,
      salary_min: null,
      salary_max: null,
      url: j.url,
      apply_url: j.url,
      source: 'Remotive',
      source_icon: '🏠',
      remote: true,
      skills: (j.tags || []).map(t => t.toLowerCase()),
      employment_type: j.job_type || 'Full-time',
      posted_date: j.publication_date || new Date().toISOString(),
      views: 0,
      applicants: 0
    }));
  }

  // ── Source: The Muse ──
  async themuse() {
    const r = await axios.get('https://www.themuse.com/api/public/jobs', {
      params: {
        page: 0,
        descending: true,
        location: 'Flexible / Remote',
        category: 'Computer and IT,Data Science,Engineering,Software Engineer'
      },
      timeout: 12000
    });
    return (r.data.results || []).map(j => ({
      id: `muse_${j.id}`,
      title: j.name || '',
      company: j.company?.name || '',
      logo: null,
      location: j.locations?.[0]?.name || 'Remote',
      description: (j.contents || '').replace(/<[^>]*>/g, ''),
      salary_raw: null,
      salary_min: null,
      salary_max: null,
      url: j.refs?.landing_page,
      apply_url: j.refs?.landing_page,
      source: 'The Muse',
      source_icon: '🎯',
      remote: j.locations?.some(l => l.name?.toLowerCase().includes('remote')) || false,
      skills: [],
      employment_type: j.type || 'Full-time',
      experience_level: j.levels?.[0]?.name || null,
      posted_date: j.publication_date || new Date().toISOString(),
      views: 0,
      applicants: 0
    }));
  }

  // ── Source: Arbeitnow ──
  async arbeitnow() {
    const r = await axios.get('https://www.arbeitnow.com/api/job-board-api', {
      timeout: 12000
    });
    return (r.data.data || [])
      .filter(j => j.remote || (j.location||'').toLowerCase().includes('remote'))
      .map(j => ({
        id: `arb_${j.slug}`,
        title: j.title || '',
        company: j.company_name || '',
        logo: null,
        location: j.location || 'Remote',
        description: (j.description || '').replace(/<[^>]*>/g, ''),
        salary_raw: null,
        salary_min: null,
        salary_max: null,
        url: j.url,
        apply_url: j.url,
        source: 'Arbeitnow',
        source_icon: '💼',
        remote: true,
        skills: (j.tags || []).map(t => t.toLowerCase()),
        employment_type: 'Full-time',
        posted_date: j.created_at
          ? new Date(j.created_at * 1000).toISOString()
          : new Date().toISOString(),
        views: 0,
        applicants: 0
      }));
  }

  // ── Source: Findwork ──
  async findwork() {
    const headers = {};
    if (process.env.FINDWORK_KEY) headers.Authorization = `Token ${process.env.FINDWORK_KEY}`;
    const r = await axios.get('https://findwork.dev/api/jobs/', {
      params: { remote: true, order_by: '-date', limit: 50 },
      headers,
      timeout: 12000
    });
    return (r.data.results || []).map(j => ({
      id: `fw_${j.id}`,
      title: j.role || '',
      company: j.company_name || '',
      logo: j.company_logo || null,
      location: j.location || 'Remote',
      description: `${j.role} at ${j.company_name}. Keywords: ${(j.keywords||[]).join(', ')}`,
      salary_raw: null,
      salary_min: null,
      salary_max: null,
      url: j.url,
      apply_url: j.url,
      source: 'Findwork',
      source_icon: '🔎',
      remote: j.remote || false,
      skills: (j.keywords || []).map(k => k.toLowerCase()),
      employment_type: j.employment_type || 'Full-time',
      posted_date: j.date_posted || new Date().toISOString(),
      views: 0,
      applicants: 0
    }));
  }

  // ── Source: Jobicy ──
  async jobicy() {
    const r = await axios.get('https://jobicy.com/api/v2/remote-jobs', {
      params: { count: 50 },
      timeout: 12000
    });
    return (r.data.jobs || []).map(j => ({
      id: `jobicy_${j.id}`,
      title: j.jobTitle || '',
      company: j.companyName || '',
      logo: j.companyLogo || null,
      location: 'Remote',
      description: (j.jobDescription || j.jobExcerpt || '').replace(/<[^>]*>/g, ''),
      salary_raw: j.jobSalary || null,
      salary_min: null,
      salary_max: null,
      url: j.url,
      apply_url: j.url,
      source: 'Jobicy',
      source_icon: '🌐',
      remote: true,
      skills: (j.jobIndustry || []).map(i => i.toLowerCase()),
      employment_type: j.jobType || 'Full-time',
      posted_date: j.pubDate || new Date().toISOString(),
      views: 0,
      applicants: 0
    }));
  }

  // ── Tag leadership/staffing/gov ──
  tag(jobs) {
    const leadership = ['lead','director','vp ','vice president','manager','principal',
      'head of','chief','cto','ceo','coo','cfo','president'];
    const staffing = ['staffing','recruiting firm','recruitment agency','headhunter',
      'talent solutions','cybercoders','robert half','manpower','adecco','kforce'];
    const gov = ['federal','government','department of','state of ','county of',
      'city of ','usajobs','.gov'];

    return jobs.map(j => ({
      ...j,
      is_leadership: leadership.some(w => j.title?.toLowerCase().includes(w)),
      is_staffing:   staffing.some(w => j.company?.toLowerCase().includes(w)),
      is_government: gov.some(w =>
        j.company?.toLowerCase().includes(w) ||
        j.description?.toLowerCase().includes(w)
      )
    }));
  }

  // ── COMPLETE FILTER ENGINE ──
  filter(jobs, f) {
    return jobs.filter(j => {

      // Remote Only
      if (f.remote_only !== false) {
        if (!j.remote && !(j.location||'').toLowerCase().includes('remote')) return false;
      }

      // USA Only
      if (f.usa_only) {
        const loc = (j.location||'').toLowerCase();
        if (!['usa','united states','america','remote','us '].some(t => loc.includes(t))) return false;
      }

      // Keywords (title + company + description + skills)
      if (f.keywords?.trim()) {
        const kw = f.keywords.toLowerCase();
        const blob = [j.title, j.company, j.description, ...(j.skills||[])].join(' ').toLowerCase();
        if (!blob.includes(kw)) return false;
      }

      // Employment Type
      if (f.employment_type) {
        const type = (j.employment_type||'').toLowerCase();
        const map = {
          fulltime:   ['full-time','fulltime','full time','permanent'],
          parttime:   ['part-time','parttime','part time'],
          contract:   ['contract','freelance','contractor','temp'],
          internship: ['intern','internship','co-op','coop']
        };
        const allowed = map[f.employment_type] || [f.employment_type];
        if (!allowed.some(t => type.includes(t))) return false;
      }

      // Experience Level
      if (f.experience_level) {
        const blob = [(j.experience_level||''), j.title, (j.description||'').slice(0,500)]
          .join(' ').toLowerCase();
        const map = {
          junior:  ['junior','entry','associate','graduate','new grad','0-2','1-2','jr.'],
          mid:     ['mid','intermediate','2-5','3-5','2+ years','3+ years','mid-level'],
          senior:  ['senior','sr.','sr ','lead','staff','5+','7+','8+','10+','expert','principal']
        };
        const terms = map[f.experience_level] || [f.experience_level];
        if (!terms.some(t => blob.includes(t))) return false;
      }

      // Exclude Leadership
      if (f.exclude_leadership && j.is_leadership) return false;

      // Exclude Staffing Agencies
      if (f.exclude_staffing && j.is_staffing) return false;

      // Exclude Government
      if (f.exclude_government && j.is_government) return false;

      // Industry
      if (f.industry) {
        const blob = [j.title, (j.description||'').slice(0,500), ...(j.skills||[])].join(' ').toLowerCase();
        const map = {
          tech:         ['software','developer','engineer','programming','tech','it '],
          healthcare:   ['health','medical','clinical','hospital','pharma','biotech'],
          finance:      ['finance','fintech','banking','investment','accounting','trading'],
          aiml:         ['ai','machine learning','ml','deep learning','nlp','data science','llm'],
          cybersecurity:['security','cyber','infosec','devsecops','soc','pentesting'],
          saas:         ['saas','b2b','platform','cloud','subscription','software-as']
        };
        const terms = map[f.industry] || [f.industry];
        if (!terms.some(t => blob.includes(t))) return false;
      }

      // Salary Min
      if (f.salary_min) {
        const min = parseInt(f.salary_min);
        if (j.salary_max && j.salary_max < min) return false;
        if (j.salary_min && j.salary_min < min && (!j.salary_max || j.salary_max < min)) return false;
      }

      // Salary Max
      if (f.salary_max) {
        const max = parseInt(f.salary_max);
        if (j.salary_min && j.salary_min > max) return false;
      }

      // Date Posted
      if (f.date_posted && f.date_posted !== 'all') {
        const hrs = (Date.now() - new Date(j.posted_date)) / 3600000;
        const limits = { today: 24, week: 168, month: 720 };
        if (limits[f.date_posted] && hrs > limits[f.date_posted]) return false;
      }

      // Skills
      if (f.skills?.length > 0) {
        const skillBlob = [...(j.skills||[]), (j.description||'').toLowerCase()].join(' ');
        if (!f.skills.some(s => skillBlob.includes(s.toLowerCase()))) return false;
      }

      // Exclude Keywords (from title)
      if (f.exclude_keywords?.length > 0) {
        const title = (j.title||'').toLowerCase();
        if (f.exclude_keywords.some(k => title.includes(k.toLowerCase()))) return false;
      }

      // Visa Sponsorship
      if (f.visa_sponsorship) {
        const desc = (j.description||'').toLowerCase();
        if (!['visa','sponsor','h1b','work authorization'].some(t => desc.includes(t))) return false;
      }

      // Easy Apply
      if (f.easy_apply) {
        if (!j.apply_url) return false;
      }

      // Fast Growing
      if (f.fast_growing) {
        const desc = (j.description||'').toLowerCase();
        if (!['fast-growing','hypergrowth','series','yc','y combinator',
               'rapidly growing','scaling','startup'].some(t => desc.includes(t))) return false;
      }

      // Low Competition
      if (f.low_competition) {
        if ((j.applicants || 0) > 50) return false;
      }

      // Company Size
      if (f.company_size) {
        const desc = (j.description||'').toLowerCase();
        const map = {
          startup: ['startup','start-up','early stage','seed','series a','small team'],
          mid:     ['series b','series c','mid-size','growing company','scale'],
          large:   ['enterprise','fortune 500','global','international','10,000','50,000']
        };
        const terms = map[f.company_size];
        if (terms && !terms.some(t => desc.includes(t))) return false;
      }

      return true;
    });
  }

  dedupe(jobs) {
    const seen = new Set();
    return jobs.filter(j => {
      if (!j.title || !j.company) return false;
      const k = `${j.title.toLowerCase().slice(0,25)}_${j.company.toLowerCase().slice(0,15)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  score(jobs, f) {
    const kw = (f.keywords||'').toLowerCase();
    return jobs.map(j => {
      let score = 50;
      if (kw) {
        if ((j.title||'').toLowerCase().includes(kw)) score += 30;
        if ((j.description||'').toLowerCase().includes(kw)) score += 10;
        if ((j.skills||[]).some(s => s.includes(kw))) score += 10;
      }
      const hrs = (Date.now() - new Date(j.posted_date)) / 3600000;
      if (hrs < 24) score += 15;
      else if (hrs < 72) score += 10;
      else if (hrs < 168) score += 5;
      if (j.salary_max || j.salary_raw) score += 10;
      if (j.logo) score += 3;
      if ((j.description||'').length > 500) score += 5;
      if ((j.skills||[]).length >= 3) score += 5;
      return { ...j, match_score: Math.min(99, score) };
    });
  }

  sort(jobs, by) {
    return [...jobs].sort({
      date:    (a,b) => new Date(b.posted_date)-new Date(a.posted_date),
      salary:  (a,b) => (b.salary_max||b.salary_min||0)-(a.salary_max||a.salary_min||0),
      match:   (a,b) => b.match_score-a.match_score,
      company: (a,b) => a.company.localeCompare(b.company),
      title:   (a,b) => a.title.localeCompare(b.title)
    }[by] || ((a,b) => new Date(b.posted_date)-new Date(a.posted_date)));
  }
}

const jobs = new JobAggregator();

// ============================================================
// AI ENGINE - 4 PROVIDERS WITH FALLBACK
// ============================================================
class AI {

  async chat(messages, context = '') {
    for (const fn of [
      () => this.gemini(messages, context),
      () => this.groq(messages, context),
      () => this.hf(messages),
      () => this.local(messages)
    ]) {
      try {
        const r = await fn();
        if (r) return r;
      } catch(e) {
        console.error('AI provider error:', e.message);
      }
    }
    return { text: 'Sorry, I had trouble responding. Please try again.', provider: 'Error' };
  }

  async gemini(msgs, ctx) {
    if (!process.env.GEMINI_API_KEY) return null;
    const system = `You are an expert AI career assistant for RemoteHunt 2026 - an advanced remote job search platform. Help users with: resume optimization, interview prep, salary negotiation, job search strategies, and career planning. Be concise, specific, and encouraging. Use occasional emojis.${ctx ? '\n\nContext: '+ctx : ''}`;
    const contents = msgs.length === 1
      ? [{ role:'user', parts:[{ text: system+'\n\n'+msgs[0].content }] }]
      : msgs.map(m => ({ role: m.role==='assistant'?'model':'user', parts:[{ text: m.content }] }));
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents, generationConfig:{ temperature:0.7, maxOutputTokens:1024 } },
      { timeout: 20000 }
    );
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? { text, provider:'Google Gemini ✨' } : null;
  }

  async groq(msgs, ctx) {
    if (!process.env.GROQ_API_KEY) return null;
    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama3-8b-8192',
        messages: [
          { role:'system', content:`You are an expert AI career assistant. Help with remote job search, resumes, interviews, and salary negotiation. Be concise and actionable.${ctx?'\nContext: '+ctx:''}` },
          ...msgs
        ],
        max_tokens: 1024,
        temperature: 0.7
      },
      {
        headers: { 'Authorization':`Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type':'application/json' },
        timeout: 15000
      }
    );
    const text = r.data?.choices?.[0]?.message?.content;
    return text ? { text, provider:'Groq Llama 3 ⚡' } : null;
  }

  async hf(msgs) {
    if (!process.env.HF_TOKEN) return null;
    const prompt = `<s>[INST] You are a career assistant. ${msgs[msgs.length-1].content} [/INST]`;
    const r = await axios.post(
      'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.1',
      { inputs: prompt, parameters:{ max_new_tokens:512, return_full_text:false } },
      { headers:{ 'Authorization':`Bearer ${process.env.HF_TOKEN}` }, timeout:30000 }
    );
    const text = r.data?.[0]?.generated_text?.trim();
    return text ? { text, provider:'HuggingFace Mistral 🤗' } : null;
  }

  local(msgs) {
    const m = (msgs[msgs.length-1]?.content||'').toLowerCase();
    const db = {
      resume: `📄 **Resume Tips for 2026:**\n\n**ATS Optimization:**\n• Use exact keywords from the job description\n• Standard fonts: Arial, Calibri, Georgia\n• No tables, graphics, or columns\n• Save as PDF unless told otherwise\n\n**Content Must-Haves:**\n• Strong summary: 2-3 lines at the top\n• Quantify everything: "Increased revenue by 40%"\n• Skills section matching job requirements\n• Reverse chronological experience\n\n**Remote-Specific:**\n• Mention remote tools: Slack, Zoom, Notion, Jira\n• Show self-management & async communication skills\n• "Worked across 4 time zones" is powerful\n\n**Format:**\n• 1 page (0-5 years) or 2 pages max (senior)\n• PDF format always\n• File name: FirstName-LastName-Resume.pdf`,

      interview: `🎤 **Remote Interview Guide 2026:**\n\n**24h Before:**\n• Test camera, mic & internet speed\n• Set up professional background\n• Research company product, mission & culture\n• Prepare 5 STAR method stories\n• Charge all devices\n\n**During Interview:**\n• Look at camera (not screen) when talking\n• Pause 2 seconds before answering\n• Keep water nearby\n• Take notes openly - shows engagement\n• Smile more than you think you need to\n\n**Remote-Specific Questions to Prep:**\n• "How do you stay productive at home?"\n• "How do you handle timezone differences?"\n• "What's your home office setup?"\n• "How do you communicate async?"\n\n**Questions to Ask Them:**\n• "What does success look like in 90 days?"\n• "How does the team communicate daily?"\n• "What's the biggest challenge in this role?"`,

      salary: `💰 **Salary Negotiation 2026:**\n\n**Research First (15 min):**\n• Glassdoor, Levels.fyi, Payscale, LinkedIn Salary\n• Built In, Blind (tech), Radford (enterprise)\n• Ask people in your network\n\n**The Golden Rules:**\n• NEVER give first number - let them anchor\n• Always negotiate (85% of companies expect it)\n• Ask for 10-20% above your target\n• Negotiate total comp: salary + equity + PTO + perks\n\n**Proven Scripts:**\n• "Based on my research and 5 years of experience, I was expecting $X-$Y. Is there flexibility?"\n• "Is the base salary flexible?"\n• "What's the budgeted range for this role?"\n• "I'm excited about this role. To make this easy to say yes to, can you do $X?"\n\n**Remote Consideration:**\n• Some companies use geo-based pay - push back on this\n• WFH stipend ($100-500/mo) is negotiable\n• Extra PTO is often easier to get than cash`,

      apply: `🚀 **Application Strategy That Works:**\n\n**Quality Over Quantity:**\n• 5-10 targeted applications > 100 random ones\n• Apply within FIRST 24 hours (3x more responses)\n• Customize resume for each role (20 min investment)\n\n**Your Weekly Goal:**\n• Mon-Wed: Apply to 5-8 jobs\n• Thu: Follow up on week-old applications\n• Fri: Network + LinkedIn activity\n\n**The Winning Formula:**\n✅ Tailored resume (keywords from JD)\n✅ Custom cover letter (3 short paragraphs)\n✅ Research company (know their product!)\n✅ Connect with hiring manager on LinkedIn\n✅ Follow up email after 5-7 days\n\n**Best Remote Job Boards:**\n• RemoteOK, Remotive, We Work Remotely\n• AngelList, Wellfound (startups)\n• Company career pages directly`,

      skills: `🎯 **Most In-Demand Skills 2026:**\n\n**Highest Paying Tech:**\n• AI/ML: Python, LangChain, RAG, LLMs\n• Cloud: AWS Solutions Architect, GCP, Azure\n• Web: React, TypeScript, Next.js, Node.js\n• Data: SQL, dbt, Spark, Airflow\n• DevOps: Kubernetes, Terraform, ArgoCD\n\n**AI Tools for Your Job Search:**\n• Claude/ChatGPT for resume tailoring\n• Perplexity for company research\n• Otter.ai for interview practice\n\n**Free Certifications That Matter:**\n• AWS Cloud Practitioner (free practice exams)\n• Google Analytics (free)\n• Meta Marketing (free)\n• HubSpot (all free)\n• freeCodeCamp (web dev)\n\n**Time to Learn:**\n• JavaScript: 3-6 months to job-ready\n• Python: 2-4 months to job-ready\n• AWS basics: 4-8 weeks`,

      default: `👋 **I'm your AI Career Assistant!**\n\nHere's what I can help with:\n\n📄 **Resume** - ATS tips, keywords, formatting\n🎤 **Interviews** - Prep, STAR method, remote tips\n💰 **Salary** - Negotiation scripts, market rates\n🚀 **Applications** - Strategy, cover letters, follow-ups\n🎯 **Skills** - What to learn, free certifications\n🔍 **Job Search** - Best platforms, smart strategies\n🏠 **Remote Work** - Productivity, tools, async tips\n\nWhat do you need help with today?`
    };

    let r = db.default;
    if (m.includes('resume')||m.includes('cv')||m.includes('ats')) r = db.resume;
    else if (m.includes('interview')||m.includes('question')) r = db.interview;
    else if (m.includes('salary')||m.includes('pay')||m.includes('negotiat')||m.includes('compensation')) r = db.salary;
    else if (m.includes('apply')||m.includes('application')||m.includes('cover')) r = db.apply;
    else if (m.includes('skill')||m.includes('learn')||m.includes('course')||m.includes('certif')) r = db.skills;

    return { text: r, provider: 'RemoteHunt AI 🤖' };
  }

  async analyzeResume(resume, jd) {
    const techSkills = [
      'javascript','typescript','python','java','c#','c++','go','rust','ruby','php','swift','kotlin',
      'react','angular','vue','nextjs','nuxt','svelte','nodejs','express','django','flask','fastapi',
      'spring','rails','laravel','asp.net','graphql','rest','grpc','websockets',
      'sql','postgresql','mysql','mongodb','redis','elasticsearch','dynamodb','cassandra','neo4j',
      'aws','azure','gcp','docker','kubernetes','terraform','ansible','jenkins','github actions','gitlab ci',
      'git','linux','bash','nginx','apache','kafka','rabbitmq','celery',
      'machine learning','deep learning','tensorflow','pytorch','scikit-learn','pandas','numpy','spark',
      'html','css','sass','tailwind','bootstrap','webpack','vite',
      'agile','scrum','kanban','jira','confluence','notion','figma','sketch'
    ];
    const soft = ['communication','leadership','teamwork','problem solving','critical thinking',
      'time management','adaptability','mentoring','collaboration','public speaking'];

    const rl = resume.toLowerCase(), jl = jd.toLowerCase();
    const rTech = techSkills.filter(s => rl.includes(s));
    const jTech = techSkills.filter(s => jl.includes(s));
    const rSoft = soft.filter(s => rl.includes(s));
    const jSoft = soft.filter(s => jl.includes(s));

    const matching = jTech.filter(s => rTech.includes(s));
    const missing  = jTech.filter(s => !rTech.includes(s));
    const extra    = rTech.filter(s => !jTech.includes(s));
    const mSoft    = jSoft.filter(s => rSoft.includes(s));
    const misSoft  = jSoft.filter(s => !rSoft.includes(s));

    const techScore = jTech.length > 0 ? Math.round(matching.length/jTech.length*100) : 70;
    const softScore = jSoft.length > 0 ? Math.round(mSoft.length/jSoft.length*100) : 70;

    // ATS Checks
    const ats = {
      hasEmail:      /[\w.-]+@[\w.-]+\.\w+/.test(resume),
      hasPhone:      /\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(resume),
      hasLinkedIn:   /linkedin/.test(rl),
      hasExperience: /experience|work history|employment/.test(rl),
      hasEducation:  /education|degree|university|bachelor|master|phd/.test(rl),
      hasSkillsSection: /skills|technologies|tools|competencies/.test(rl),
      hasBullets:    /•|-|\*/m.test(resume),
      hasQuantified: /\d+%|\$[\d,]+|\d+ (people|team|users|clients|employees)/.test(resume),
      goodLength:    resume.split(' ').length >= 300 && resume.split(' ').length <= 1200,
      noTables:      !/<table/i.test(resume),
      hasRemoteExp:  /remote|distributed|async|virtual team/.test(rl)
    };

    const atsScore = Math.round(Object.values(ats).filter(Boolean).length / Object.keys(ats).length * 100);
    const overall  = Math.round(techScore*0.45 + softScore*0.15 + atsScore*0.4);

    const improvements = [];
    if (!ats.hasQuantified)    improvements.push('Add quantified achievements: "Increased performance by 40%"');
    if (!ats.hasRemoteExp)     improvements.push('Mention remote work experience and collaboration tools');
    if (!ats.hasSkillsSection) improvements.push('Add a dedicated "Skills" or "Technologies" section');
    if (!ats.hasBullets)       improvements.push('Use bullet points for better ATS scanning');
    if (!ats.goodLength)       improvements.push(resume.split(' ').length < 300
      ? 'Resume is too short - add more detail about your experience'
      : 'Resume may be too long - aim for 1-2 pages');
    if (missing.length > 0)    improvements.push(`Add these missing skills if you have them: ${missing.slice(0,5).join(', ')}`);
    if (!ats.hasLinkedIn)      improvements.push('Add your LinkedIn profile URL');

    // AI-enhanced analysis
    let aiText = null;
    if (process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY) {
      try {
        const prompt = `You are a resume expert. Analyze this match in exactly 3 sentences. Be specific and actionable.\n\nCandidate skills: ${rTech.slice(0,10).join(', ')}\nJob requires: ${jTech.slice(0,10).join(', ')}\nMatch: ${overall}%\nATS Score: ${atsScore}%`;
        const r = await this.chat([{ role:'user', content: prompt }]);
        aiText = r.text;
      } catch {}
    }

    return {
      overall, techScore, softScore, atsScore,
      matching: [...matching, ...mSoft],
      missing:  [...missing,  ...misSoft],
      extra,
      ats, improvements,
      keywordsToAdd: missing.slice(0, 8),
      aiAnalysis: aiText
    };
  }
}

const ai = new AI();

// ============================================================
// ROUTES
// ============================================================

// ── Health ──
app.get('/api/health', (req, res) => res.json({
  status: 'healthy',
  version: '2.0.0',
  timestamp: new Date().toISOString(),
  uptime: Math.round(process.uptime()),
  ai: {
    gemini: !!process.env.GEMINI_API_KEY,
    groq:   !!process.env.GROQ_API_KEY,
    hf:     !!process.env.HF_TOKEN,
    active: process.env.GEMINI_API_KEY ? 'Gemini'
          : process.env.GROQ_API_KEY   ? 'Groq'
          : process.env.HF_TOKEN       ? 'HuggingFace'
          : 'Local'
  },
  sources: ['RemoteOK','Remotive','The Muse','Arbeitnow','Findwork','Jobicy']
}));

// ── Auth ──
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name||!email||!password)
      return res.status(400).json({ success:false, error:'All fields required' });
    if (password.length < 6)
      return res.status(400).json({ success:false, error:'Password must be at least 6 characters' });
    if (db.findEmail(email))
      return res.status(400).json({ success:false, error:'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const user = db.createUser({ name, email: email.toLowerCase(), password: hash });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

    db.addNotif(user.id, { type:'welcome', title:'Welcome to RemoteHunt 2026! 🎉',
      message:'Start by searching for jobs or uploading your resume for analysis.' });

    const { password:_, ...safe } = user;
    res.json({ success:true, token, user:safe });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.findEmail(email);
    if (!user) return res.status(401).json({ success:false, error:'Invalid email or password' });
    if (!await bcrypt.compare(password, user.password))
      return res.status(401).json({ success:false, error:'Invalid email or password' });

    const token = jwt.sign({ userId:user.id }, JWT_SECRET, { expiresIn:'30d' });
    const { password:_, ...safe } = user;
    res.json({ success:true, token, user:safe });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const { password:_, ...safe } = req.user;
  res.json({ success:true, user:safe });
});

app.put('/api/auth/preferences', requireAuth, (req, res) => {
  try {
    const updated = db.updateUser(req.user.id, {
      preferences: { ...req.user.preferences, ...req.body }
    });
    res.json({ success:true, preferences:updated.preferences });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.put('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { name, bio, location, linkedin_url, github_url, portfolio_url } = req.body;
    const updated = db.updateUser(req.user.id, {
      name, bio, location, linkedin_url, github_url, portfolio_url
    });
    const { password:_, ...safe } = updated;
    res.json({ success:true, user:safe });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// ── Jobs ──
app.get('/api/jobs/search', optAuth, async (req, res) => {
  try {
    const prefs = req.user?.preferences || {};
    const q = req.query;

    const filters = {
      keywords:          q.keywords || q.q || '',
      remote_only:       q.remote_only !== 'false',
      usa_only:          q.usa_only === 'true',
      employment_type:   q.employment_type || prefs.employment_type || '',
      experience_level:  q.experience_level || prefs.experience_level || '',
      industry:          q.industry || prefs.industry || '',
      exclude_leadership: q.exclude_leadership !== 'false',
      exclude_staffing:  q.exclude_staffing !== 'false',
      exclude_government: q.exclude_government === 'true',
      salary_min:        q.salary_min ? parseInt(q.salary_min) : (prefs.salary_min||null),
      salary_max:        q.salary_max ? parseInt(q.salary_max) : null,
      date_posted:       q.date_posted || prefs.date_posted || 'week',
      skills:            q.skills ? q.skills.split(',').map(s=>s.trim()).filter(Boolean) : (prefs.skills||[]),
      exclude_keywords:  q.exclude_keywords ? q.exclude_keywords.split(',').map(s=>s.trim()) : (prefs.excluded_keywords||[]),
      visa_sponsorship:  q.visa_sponsorship === 'true',
      easy_apply:        q.easy_apply === 'true',
      fast_growing:      q.fast_growing === 'true',
      low_competition:   q.low_competition === 'true',
      company_size:      q.company_size || '',
      sort:              q.sort || 'date'
    };

    const result = await jobs.fetch(filters);

    const page  = parseInt(q.page) || 1;
    const limit = parseInt(q.limit) || 20;
    const start = (page-1)*limit;
    const slice = result.jobs.slice(start, start+limit);

    // Mark saved jobs if user is logged in
    if (req.user) {
      slice.forEach(j => { j.is_saved = db.isSaved(req.user.id, j.id); });
    }

    res.json({
      success: true,
      jobs: slice,
      total: result.jobs.length,
      page,
      totalPages: Math.ceil(result.jobs.length/limit),
      hasMore: start+limit < result.jobs.length,
      sources: result.stats,
      filters
    });
  } catch(e) {
    console.error('Search error:', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

// ── Saved Jobs ──
app.post('/api/jobs/save', requireAuth, (req, res) => {
  const { job } = req.body;
  if (!job) return res.status(400).json({ success:false, error:'Job required' });
  const saved = db.saveJob(req.user.id, job);
  if (saved) {
    db.addNotif(req.user.id, { type:'saved', title:'Job saved ❤️',
      message:`${job.title} at ${job.company} saved to your list` });
  }
  res.json({ success:true, saved, message: saved ? 'Job saved!' : 'Already saved' });
});

app.delete('/api/jobs/save/:jobId', requireAuth, (req, res) => {
  db.unsaveJob(req.user.id, req.params.jobId);
  res.json({ success:true });
});

app.get('/api/jobs/saved', requireAuth, (req, res) => {
  const saved = db.getSaved(req.user.id);
  res.json({ success:true, jobs:saved, total:saved.length });
});

// ── Applications ──
app.get('/api/applications', requireAuth, (req, res) => {
  const apps = db.userApps(req.user.id);
  res.json({ success:true, applications:apps, total:apps.length });
});

app.post('/api/applications', requireAuth, (req, res) => {
  try {
    const { job, status, notes, coverLetter } = req.body;
    if (!job) return res.status(400).json({ success:false, error:'Job required' });

    const exists = db.userApps(req.user.id).find(a => a.jobId === job.id);
    if (exists) return res.json({ success:true, application:exists, already:true });

    const app = db.addApp({
      userId: req.user.id,
      jobId: job.id,
      job,
      status: status || 'applied',
      notes: notes || '',
      coverLetter: coverLetter || '',
      timeline: [{ status:'applied', date:new Date().toISOString(), note:'Application tracked' }]
    });

    db.addNotif(req.user.id, { type:'tracked', title:'Application tracked 📋',
      message:`${job.title} at ${job.company} added to your tracker` });

    res.json({ success:true, application:app });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.put('/api/applications/:id', requireAuth, (req, res) => {
  try {
    const { status, notes, interviewDate } = req.body;
    const existing = db.apps.get(req.params.id);
    if (!existing || existing.userId !== req.user.id)
      return res.status(404).json({ success:false, error:'Application not found' });

    const timeline = [...(existing.timeline||[]),
      { status, date:new Date().toISOString(), note:notes||'' }];

    const updated = db.updateApp(req.params.id, { status, notes, interviewDate, timeline });
    res.json({ success:true, application:updated });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/applications/:id', requireAuth, (req, res) => {
  const existing = db.apps.get(req.params.id);
  if (!existing || existing.userId !== req.user.id)
    return res.status(404).json({ success:false, error:'Not found' });
  db.deleteApp(req.params.id);
  res.json({ success:true });
});

// ── Resume ──
app.post('/api/resume/analyze', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body;
    if (!resumeText||!jobDescription)
      return res.status(400).json({ success:false, error:'Both resume and job description required' });
    const analysis = await ai.analyzeResume(resumeText, jobDescription);
    res.json({ success:true, analysis });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/resume/save', requireAuth, (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title||!content)
      return res.status(400).json({ success:false, error:'Title and content required' });
    const resume = db.saveResume(req.user.id, { title, content });
    res.json({ success:true, resume });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/resume/list', requireAuth, (req, res) => {
  res.json({ success:true, resumes: db.getResumes(req.user.id) });
});

// ── Chat ──
app.post('/api/chat', optAuth, async (req, res) => {
  try {
    const { message, conversationId, context } = req.body;
    if (!message) return res.status(400).json({ success:false, error:'Message required' });

    const convId = conversationId || uuidv4();
    const history = cache.get(`chat_${convId}`) || [];
    history.push({ role:'user', content: message });

    const response = await ai.chat(history.slice(-10), context||'');

    history.push({ role:'assistant', content: response.text });
    cache.set(`chat_${convId}`, history, 3600);

    res.json({ success:true, conversationId:convId, response });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// ── Alerts ──
app.get('/api/alerts', requireAuth, (req, res) => {
  res.json({ success:true, alerts: db.getAlerts(req.user.id) });
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { name, filters } = req.body;
  if (!name||!filters) return res.status(400).json({ success:false, error:'Name and filters required' });
  const alert = db.addAlert(req.user.id, { name, filters });
  res.json({ success:true, alert });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  db.deleteAlert(req.user.id, req.params.id);
  res.json({ success:true });
});

// ── Notifications ──
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifs = db.getNotifs(req.user.id);
  res.json({ success:true, notifications:notifs, unread:notifs.filter(n=>!n.read).length });
});

app.put('/api/notifications/read-all', requireAuth, (req, res) => {
  db.markAllRead(req.user.id);
  res.json({ success:true });
});

app.put('/api/notifications/:id/read', requireAuth, (req, res) => {
  db.markRead(req.user.id, req.params.id);
  res.json({ success:true });
});

// ── Analytics ──
app.get('/api/analytics', requireAuth, (req, res) => {
  const apps    = db.userApps(req.user.id);
  const saved   = db.getSaved(req.user.id);
  const byStatus = apps.reduce((a,b) => ({ ...a, [b.status]:(a[b.status]||0)+1 }), {});
  const interviews = (byStatus.interviewing||0)+(byStatus.offered||0)+(byStatus.accepted||0);
  res.json({
    success: true,
    data: {
      totalApplications: apps.length,
      savedJobs: saved.length,
      byStatus,
      responseRate: apps.length > 0 ? Math.round(interviews/apps.length*100) : 0,
      interviews,
      offers: byStatus.offered||0,
      weeklyApps: apps.filter(a => (Date.now()-new Date(a.createdAt)) < 604800000).length
    }
  });
});

// ── Frontend ──
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML);
});

// ============================================================
// FRONTEND HTML
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0">
<meta name="description" content="RemoteHunt 2026 - AI-Powered Remote Job Search Platform">
<meta name="theme-color" content="#6366f1">
<title>RemoteHunt 2026</title>
<link rel="manifest" href="/manifest.json">
<style>
/* ── Reset ── */
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --p:#6366f1;--p2:#4f46e5;--s:#06b6d4;--g:#10b981;--w:#f59e0b;--r:#ef4444;
  --bg:#f1f5f9;--card:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0;
  --nav:64px;--radius:12px;--shadow:0 4px 16px rgba(0,0,0,.08);
  --shadow-lg:0 12px 40px rgba(0,0,0,.12)
}
[data-dark]{
  --bg:#0f172a;--card:#1e293b;--text:#f1f5f9;
  --muted:#94a3b8;--border:#334155
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;transition:background .3s,color .3s}
a{color:inherit;text-decoration:none}
button,input,select,textarea{font-family:inherit}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* ── Nav ── */
nav{position:sticky;top:0;z-index:100;height:var(--nav);background:var(--card);
  border-bottom:1px solid var(--border);display:flex;align-items:center;
  padding:0 20px;gap:16px;box-shadow:var(--shadow)}
.logo{font-size:20px;font-weight:800;white-space:nowrap;
  background:linear-gradient(135deg,var(--p),var(--s));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tabs{display:flex;gap:2px;background:var(--bg);padding:4px;border-radius:10px;flex:0 0 auto}
.tab{padding:7px 14px;border:none;background:transparent;color:var(--muted);
  font-size:13px;font-weight:500;border-radius:7px;cursor:pointer;transition:.2s;white-space:nowrap}
.tab.on{background:var(--card);color:var(--p);box-shadow:var(--shadow)}
.nav-r{display:flex;gap:8px;align-items:center;margin-left:auto;flex-shrink:0}
.ic-btn{width:38px;height:38px;border:1px solid var(--border);background:var(--card);
  color:var(--muted);border-radius:9px;display:flex;align-items:center;justify-content:center;
  font-size:17px;cursor:pointer;transition:.2s;position:relative}
.ic-btn:hover{background:var(--p);color:#fff;border-color:var(--p)}
.n-badge{position:absolute;top:-4px;right:-4px;background:var(--r);color:#fff;
  border-radius:50%;width:17px;height:17px;font-size:10px;font-weight:700;
  display:flex;align-items:center;justify-content:center}

/* ── Pages ── */
.pages{min-height:calc(100vh - var(--nav))}
.pg{display:none;padding:24px;max-width:1280px;margin:0 auto;width:100%}
.pg.on{display:block}

/* ── Search Hero ── */
.hero{text-align:center;padding:36px 0 28px}
.hero h1{font-size:38px;font-weight:800;line-height:1.2;margin-bottom:10px}
.grad{background:linear-gradient(135deg,var(--p),var(--s));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{color:var(--muted);font-size:16px;margin-bottom:24px}
.srch{max-width:680px;margin:0 auto}
.srch-bar{display:flex;gap:10px;background:var(--card);padding:8px;
  border-radius:16px;border:2px solid transparent;
  box-shadow:0 8px 32px rgba(99,102,241,.12);transition:.3s}
.srch-bar:focus-within{border-color:var(--p)}
.srch-bar input{flex:1;border:none;outline:none;font-size:16px;
  background:transparent;color:var(--text);padding:6px 8px}
.srch-bar input::placeholder{color:var(--muted)}
.btn{display:inline-flex;align-items:center;gap:7px;padding:11px 22px;
  border:none;border-radius:9px;font-weight:600;font-size:14px;cursor:pointer;transition:.2s}
.btn-p{background:linear-gradient(135deg,var(--p),var(--p2));color:#fff}
.btn-p:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(99,102,241,.4)}
.btn-p:disabled{opacity:.6;cursor:not-allowed;transform:none}
.btn-o{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-o:hover{border-color:var(--p);color:var(--p)}
.btn-sm{padding:7px 14px;font-size:13px}
.btn-g{background:var(--g);color:#fff}
.btn-r{background:var(--r);color:#fff}
.q-tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px;justify-content:center}
.q-tag{padding:6px 14px;background:var(--card);border:1px solid var(--border);
  border-radius:20px;font-size:13px;color:var(--muted);cursor:pointer;transition:.2s}
.q-tag:hover{background:var(--p);color:#fff;border-color:var(--p);transform:translateY(-1px)}

/* ── Filters ── */
.fil-wrap{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:20px;margin-bottom:20px}
.fil-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.fil-head strong{font-size:15px}
.fil-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.fg{display:flex;flex-direction:column;gap:4px}
.flbl{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.fsel,.finp{padding:9px 11px;border:1px solid var(--border);border-radius:8px;
  background:var(--bg);color:var(--text);font-size:13px;outline:none;transition:.2s;width:100%}
.fsel:focus,.finp:focus{border-color:var(--p)}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:9px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
.chk{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;
  padding:6px;border-radius:7px;transition:.15s}
.chk:hover{background:var(--bg)}
.chk input{width:15px;height:15px;accent-color:var(--p);cursor:pointer}
.sal-row{display:flex;gap:10px;margin-top:12px}
.sal-row input{flex:1;padding:9px 11px;border:1px solid var(--border);border-radius:8px;
  background:var(--bg);color:var(--text);font-size:13px;outline:none}
.sal-row input:focus{border-color:var(--p)}
.smart{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px;
  padding-top:14px;border-top:1px solid var(--border);align-items:center}
.sf{padding:7px 14px;border:2px solid var(--border);background:transparent;
  border-radius:20px;font-size:13px;font-weight:500;color:var(--muted);
  cursor:pointer;transition:.2s}
.sf:hover,.sf.on{border-color:var(--p);background:var(--p);color:#fff}

/* ── Stats ── */
.stats-bar{background:linear-gradient(135deg,var(--p),var(--s));color:#fff;padding:14px 20px;
  border-radius:var(--radius);margin-bottom:18px;display:flex;
  justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.s-num{font-size:28px;font-weight:800}
.src-tags{display:flex;gap:6px;flex-wrap:wrap}
.src-tag{padding:3px 10px;background:rgba(255,255,255,.2);border-radius:20px;font-size:12px}

/* ── Job Cards ── */
.jlist{display:grid;gap:14px}
.jcard{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:20px;cursor:pointer;transition:all .25s;position:relative;overflow:hidden}
.jcard::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
  background:linear-gradient(180deg,var(--p),var(--s));opacity:0;transition:.3s}
.jcard:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:rgba(99,102,241,.3)}
.jcard:hover::before{opacity:1}
.jc-top{display:flex;gap:12px;align-items:flex-start;margin-bottom:10px}
.co-logo{width:46px;height:46px;border-radius:9px;object-fit:contain;
  background:var(--bg);border:1px solid var(--border);padding:4px;flex-shrink:0}
.co-init{width:46px;height:46px;border-radius:9px;
  background:linear-gradient(135deg,var(--p),var(--s));color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:18px;
  font-weight:700;flex-shrink:0}
.jc-inf{flex:1;min-width:0}
.jc-title{font-size:17px;font-weight:700;line-height:1.3;margin-bottom:2px}
.jc-co{font-size:14px;color:var(--muted);font-weight:500}
.jc-score{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;
  background:linear-gradient(135deg,var(--p),var(--s));color:#fff;
  white-space:nowrap;flex-shrink:0}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;font-size:13px;color:var(--muted)}
.meta span{display:flex;align-items:center;gap:3px}
.pill{padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.p-rem{background:#d1fae5;color:#065f46}
.p-sal{background:#dbeafe;color:#1e40af}
.p-new{background:#fef3c7;color:#92400e}
.p-typ{background:#f3e8ff;color:#6b21a8}
.jdesc{font-size:13px;color:var(--muted);line-height:1.6;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:8px 0}
.stags{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
.stag{padding:3px 9px;background:var(--bg);border:1px solid var(--border);
  border-radius:20px;font-size:11px;color:var(--muted)}
.jfoot{display:flex;justify-content:space-between;align-items:center;
  margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.jsrc{font-size:12px;color:var(--muted)}
.jacts{display:flex;gap:7px}
.sv-btn{width:34px;height:34px;border:1px solid var(--border);background:transparent;
  border-radius:8px;font-size:17px;display:flex;align-items:center;
  justify-content:center;cursor:pointer;transition:.2s}
.sv-btn:hover,.sv-btn.on{background:var(--w);border-color:var(--w);color:#fff}

/* ── Loading ── */
.ld{text-align:center;padding:50px 20px}
.spin{width:44px;height:44px;border:4px solid var(--border);
  border-top-color:var(--p);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.dots{display:flex;gap:7px;justify-content:center;margin-bottom:14px}
.dot{width:11px;height:11px;background:var(--p);border-radius:50%;animation:bop 1.4s ease-in-out infinite}
.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
@keyframes bop{0%,80%,100%{transform:scale(0);opacity:.4}40%{transform:scale(1);opacity:1}}
.empty{text-align:center;padding:55px 20px;color:var(--muted)}
.empty-ico{font-size:44px;margin-bottom:12px}
.empty h3{margin-bottom:6px;color:var(--text)}

/* ── Resume Page ── */
.pg-hdr{text-align:center;margin-bottom:28px}
.pg-hdr h1{font-size:30px;font-weight:800;margin-bottom:6px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px}
.card h3{font-size:15px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:7px}
textarea{width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;
  background:var(--bg);color:var(--text);resize:vertical;outline:none;
  font-size:13px;line-height:1.7;transition:.2s}
textarea:focus{border-color:var(--p)}

/* ── Score Ring ── */
.ring{position:relative;width:130px;height:130px;margin:16px auto}
.ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.ring-txt{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
.ring-n{font-size:32px;font-weight:800}
.ring-l{font-size:11px;color:var(--muted)}
.sub-scores{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:14px}
.ss{text-align:center}
.ss-n{font-size:20px;font-weight:800}
.ss-l{font-size:11px;color:var(--muted)}
.pbar{height:5px;background:var(--bg);border-radius:3px;margin-top:5px;overflow:hidden}
.pfill{height:100%;border-radius:3px;transition:width 1.2s ease}
.skills-wrap{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.sk{padding:4px 11px;border-radius:20px;font-size:12px;font-weight:500}
.sk-y{background:#d1fae5;color:#065f46}
.sk-n{background:#fee2e2;color:#991b1b}
.sk-e{background:#dbeafe;color:#1e40af}
.tip-list li{font-size:13px;color:var(--muted);padding:8px 0;
  border-bottom:1px solid var(--border);list-style:none;display:flex;gap:8px;align-items:flex-start}
.tip-list li:last-child{border-bottom:none}
.ats-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.ats-item{display:flex;align-items:center;gap:7px;font-size:12px;padding:5px 8px;
  border-radius:6px;background:var(--bg)}

/* ── Kanban ── */
.kanban{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.kcol{background:var(--bg);border-radius:var(--radius);padding:14px}
.kcol-title{font-weight:700;font-size:13px;margin-bottom:12px;
  display:flex;align-items:center;gap:7px}
.kcard{background:var(--card);border:1px solid var(--border);border-radius:9px;
  padding:12px;margin-bottom:9px}
.kcard h4{font-size:13px;font-weight:600;margin-bottom:3px}
.kcard p{font-size:12px;color:var(--muted)}
.kcard-date{font-size:11px;color:var(--muted);margin-top:6px}
.kcard-actions{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}

/* ── Dashboard ── */
.dash-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
.dc{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.dc-n{font-size:34px;font-weight:800;background:linear-gradient(135deg,var(--p),var(--s));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.dc-l{font-size:13px;color:var(--muted);margin-top:3px}

/* ── Chat ── */
.chat-fab{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;
  background:linear-gradient(135deg,var(--p),var(--s));color:#fff;border:none;
  font-size:22px;box-shadow:0 4px 20px rgba(99,102,241,.45);z-index:200;
  cursor:pointer;transition:.3s}
.chat-fab:hover{transform:scale(1.1)}
.chat-pnl{position:fixed;right:20px;bottom:88px;width:355px;max-height:520px;
  background:var(--card);border-radius:20px;box-shadow:var(--shadow-lg);
  display:none;flex-direction:column;z-index:200;overflow:hidden;
  border:1px solid var(--border)}
.chat-pnl.on{display:flex}
.chat-hd{background:linear-gradient(135deg,var(--p),var(--s));color:#fff;
  padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
.chat-hd h3{font-size:14px;font-weight:700}
.chat-hd p{font-size:11px;opacity:.8;margin-top:2px}
.chat-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.cm{max-width:87%;padding:11px 14px;border-radius:14px;font-size:13px;line-height:1.6}
.cm.bot{background:var(--bg);align-self:flex-start;border-bottom-left-radius:3px}
.cm.user{background:var(--p);color:#fff;align-self:flex-end;border-bottom-right-radius:3px}
.chat-suggs{padding:0 14px 10px;display:flex;flex-wrap:wrap;gap:5px}
.csugg{padding:5px 11px;border:1px solid var(--border);background:transparent;
  border-radius:20px;font-size:12px;color:var(--muted);cursor:pointer;transition:.2s}
.csugg:hover{border-color:var(--p);color:var(--p)}
.chat-ft{padding:10px;border-top:1px solid var(--border);display:flex;gap:7px}
.chat-ft input{flex:1;padding:9px 13px;border:1px solid var(--border);border-radius:9px;
  background:var(--bg);color:var(--text);outline:none;font-size:13px}
.chat-ft input:focus{border-color:var(--p)}
.send{width:36px;height:36px;background:var(--p);color:#fff;border:none;
  border-radius:8px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.ai-lbl{font-size:11px;color:var(--muted);padding:4px 14px;
  border-top:1px solid var(--border);text-align:center}
.typing-dots span{display:inline-block;width:7px;height:7px;background:var(--muted);
  border-radius:50%;animation:bop 1.4s ease-in-out infinite;margin:0 2px}
.typing-dots span:nth-child(2){animation-delay:.2s}
.typing-dots span:nth-child(3){animation-delay:.4s}

/* ── Modal ── */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);
  z-index:300;align-items:center;justify-content:center;padding:16px}
.modal-bg.on{display:flex}
.modal{background:var(--card);border-radius:18px;max-width:780px;width:100%;
  max-height:88vh;overflow-y:auto;padding:28px;position:relative;
  animation:mIn .3s ease}
@keyframes mIn{from{opacity:0;transform:translateY(24px)}}
.mcls{position:absolute;top:14px;right:14px;width:34px;height:34px;border:none;
  background:var(--bg);border-radius:50%;font-size:16px;color:var(--muted);cursor:pointer;transition:.2s}
.mcls:hover{background:var(--r);color:#fff}

/* ── Auth ── */
.auth-wrap{max-width:380px;margin:50px auto}
.auth-inp{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:9px;
  background:var(--bg);color:var(--text);font-size:14px;outline:none;
  margin-bottom:11px;transition:.2s}
.auth-inp:focus{border-color:var(--p)}
.auth-sw{text-align:center;margin-top:14px;font-size:14px;color:var(--muted)}
.auth-sw span{color:var(--p);font-weight:600;cursor:pointer}

/* ── Toasts ── */
.toasts{position:fixed;bottom:20px;left:20px;z-index:400;display:flex;flex-direction:column;gap:7px}
.toast{padding:11px 18px;border-radius:10px;background:var(--card);
  border:1px solid var(--border);box-shadow:var(--shadow-lg);font-size:13px;
  display:flex;align-items:center;gap:9px;animation:tIn .3s ease;max-width:300px;min-width:220px}
@keyframes tIn{from{opacity:0;transform:translateX(-20px)}}
.toast.s{border-left:4px solid var(--g)}
.toast.e{border-left:4px solid var(--r)}
.toast.i{border-left:4px solid var(--p)}
.toast.w{border-left:4px solid var(--w)}

/* ── Load More ── */
.load-more{text-align:center;margin-top:20px;padding-bottom:30px}

/* ── Responsive ── */
@media(max-width:768px){
  nav{padding:0 12px;gap:8px}
  .tabs .tab span{display:none}
  .hero h1{font-size:26px}
  .srch-bar{flex-wrap:wrap}
  .srch-bar input{min-width:0}
  .two{grid-template-columns:1fr}
  .chat-pnl{width:calc(100vw - 20px);right:10px}
  .pg{padding:14px}
  .modal{padding:18px;border-radius:14px}
  .fil-grid{grid-template-columns:1fr 1fr}
  .kanban{grid-template-columns:1fr}
}
@media(max-width:480px){
  .fil-grid{grid-template-columns:1fr}
  .checks{grid-template-columns:1fr 1fr}
  .hero h1{font-size:22px}
  .tab{padding:7px 10px}
}
</style>
</head>
<body>

<nav>
  <div class="logo">🏠 RemoteHunt</div>
  <div class="tabs">
    <button class="tab on" onclick="pg('search',this)">🔍 <span>Jobs</span></button>
    <button class="tab" onclick="pg('resume',this)">📄 <span>Resume</span></button>
    <button class="tab" onclick="pg('apps',this)">📋 <span>Tracker</span></button>
    <button class="tab" onclick="pg('dash',this)">📊 <span>Dashboard</span></button>
  </div>
  <div class="nav-r">
    <button class="ic-btn" onclick="toggleDark()" id="themeBtn" title="Toggle theme">🌙</button>
    <div style="position:relative">
      <button class="ic-btn" id="notifBtn" onclick="pg('notifs',this)" title="Notifications">🔔
        <span class="n-badge" id="nBadge" style="display:none">0</span>
      </button>
    </div>
    <button class="ic-btn" id="authBtn" onclick="pg('auth',this)" title="Account">👤</button>
  </div>
</nav>

<div class="pages">

<!-- ══ SEARCH ══ -->
<div id="pg-search" class="pg on">
  <div class="hero">
    <h1>Find Your <span class="grad">Dream Remote Job</span></h1>
    <p>Real-time search across 6 live platforms • AI-powered matching • All filters included</p>
    <div class="srch">
      <div class="srch-bar">
        <span style="font-size:18px;color:var(--muted);padding:0 4px">🔍</span>
        <input id="kw" placeholder="Job title, skills, or company..." value="software developer"
          onkeydown="if(event.key==='Enter')search()">
        <button class="btn btn-p" onclick="search()" id="sBtn">Search</button>
      </div>
      <div class="q-tags" id="qTags">
        <span class="q-tag" onclick="qs('react developer')">⚛️ React</span>
        <span class="q-tag" onclick="qs('python engineer')">🐍 Python</span>
        <span class="q-tag" onclick="qs('data analyst')">📊 Data</span>
        <span class="q-tag" onclick="qs('product manager')">🎯 Product</span>
        <span class="q-tag" onclick="qs('ui ux designer')">🎨 Design</span>
        <span class="q-tag" onclick="qs('devops engineer')">⚙️ DevOps</span>
        <span class="q-tag" onclick="qs('machine learning engineer')">🤖 ML/AI</span>
        <span class="q-tag" onclick="qs('cybersecurity analyst')">🔒 Security</span>
        <span class="q-tag" onclick="qs('technical writer')">✍️ Writing</span>
        <span class="q-tag" onclick="qs('customer success')">🤝 Success</span>
      </div>
    </div>
  </div>

  <!-- FILTERS -->
  <div class="fil-wrap">
    <div class="fil-head">
      <strong>🎛️ Advanced Filters</strong>
      <div style="display:flex;gap:8px">
        <button class="btn btn-o btn-sm" onclick="savePrefs()">💾 Save</button>
        <button class="btn btn-o btn-sm" onclick="resetAll()">↺ Reset</button>
      </div>
    </div>

    <div class="fil-grid">
      <div class="fg">
        <div class="flbl">Job Type</div>
        <select class="fsel" id="fType">
          <option value="">All Types</option>
          <option value="fulltime">Full-time</option>
          <option value="contract">Contract</option>
          <option value="parttime">Part-time</option>
          <option value="internship">Internship</option>
        </select>
      </div>
      <div class="fg">
        <div class="flbl">Experience Level</div>
        <select class="fsel" id="fLvl">
          <option value="">All Levels</option>
          <option value="junior">Junior</option>
          <option value="mid">Mid-level</option>
          <option value="senior">Senior</option>
        </select>
      </div>
      <div class="fg">
        <div class="flbl">Industry</div>
        <select class="fsel" id="fInd">
          <option value="">All Industries</option>
          <option value="tech">💻 Tech</option>
          <option value="healthcare">🏥 Healthcare</option>
          <option value="finance">💰 Finance</option>
          <option value="aiml">🤖 AI/ML</option>
          <option value="cybersecurity">🔒 Cybersecurity</option>
          <option value="saas">☁️ SaaS</option>
        </select>
      </div>
      <div class="fg">
        <div class="flbl">Company Size</div>
        <select class="fsel" id="fSize">
          <option value="">Any Size</option>
          <option value="startup">🚀 Startup</option>
          <option value="mid">📈 Mid-size</option>
          <option value="large">🏢 Enterprise</option>
        </select>
      </div>
      <div class="fg">
        <div class="flbl">Posted</div>
        <select class="fsel" id="fDate">
          <option value="today">Last 24 Hours</option>
          <option value="week" selected>Last 7 Days</option>
          <option value="month">Last 30 Days</option>
          <option value="all">All Time</option>
        </select>
      </div>
      <div class="fg">
        <div class="flbl">Sort By</div>
        <select class="fsel" id="fSort">
          <option value="date">🕐 Most Recent</option>
          <option value="match">⚡ Best Match</option>
          <option value="salary">💰 Highest Salary</option>
          <option value="company">🏢 Company A-Z</option>
        </select>
      </div>
      <div class="fg" style="grid-column:span 2">
        <div class="flbl">Skills / Keywords (comma separated)</div>
        <input class="finp" id="fSkills" placeholder="e.g. react, python, aws, typescript...">
      </div>
      <div class="fg" style="grid-column:span 2">
        <div class="flbl">Exclude Keywords from Title</div>
        <input class="finp" id="fExcKw" placeholder="e.g. manager, director, intern...">
      </div>
    </div>

    <div class="sal-row">
      <input type="number" id="fSalMin" class="finp" placeholder="💰 Min salary ($)">
      <input type="number" id="fSalMax" class="finp" placeholder="💰 Max salary ($)">
    </div>

    <div class="checks">
      <label class="chk"><input type="checkbox" id="fRem" checked> 🏠 Remote Only</label>
      <label class="chk"><input type="checkbox" id="fUSA"> 🇺🇸 USA Only</label>
      <label class="chk"><input type="checkbox" id="fNoLead" checked> 🚫 Exclude Leadership</label>
      <label class="chk"><input type="checkbox" id="fNoStaff" checked> 🚫 Exclude Staffing Agencies</label>
      <label class="chk"><input type="checkbox" id="fNoGov"> 🚫 Exclude Gov Jobs</label>
      <label class="chk"><input type="checkbox" id="fVisa"> ✈️ Visa Sponsorship</label>
    </div>

    <div class="smart">
      <span style="font-size:12px;font-weight:700;color:var(--muted)">⚡ SMART:</span>
      <button class="sf" id="sf0" onclick="smart('best_match')">🎯 Best Match</button>
      <button class="sf" id="sf1" onclick="smart('high_salary')">💰 High Salary</button>
      <button class="sf" id="sf2" onclick="smart('easy_apply')">⚡ Easy Apply</button>
      <button class="sf" id="sf3" onclick="smart('fast_growing')">🚀 Fast Growing</button>
      <button class="sf" id="sf4" onclick="smart('low_competition')">🎯 Low Competition</button>
    </div>
  </div>

  <!-- STATS BAR -->
  <div id="sBar" class="stats-bar" style="display:none">
    <div><div class="s-num" id="sNum">0</div><div style="font-size:13px">Jobs Found</div></div>
    <div class="src-tags" id="srcTags"></div>
  </div>

  <!-- LOADING -->
  <div id="ldState" class="ld" style="display:none">
    <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <p style="font-weight:600;margin-bottom:6px">Searching live job platforms...</p>
    <p style="font-size:13px;color:var(--muted)" id="ldMsg">Connecting to RemoteOK, Remotive, The Muse...</p>
  </div>

  <!-- JOB LIST -->
  <div id="jList" class="jlist">
    <div class="empty"><div class="empty-ico">🎯</div>
      <h3>Ready to find your dream job?</h3>
      <p style="margin-top:6px">Use the search bar and filters above to discover remote opportunities</p>
    </div>
  </div>

  <div id="ldMore" class="load-more" style="display:none">
    <button class="btn btn-o" onclick="more()">Load More Jobs ↓</button>
  </div>
</div>

<!-- ══ RESUME ══ -->
<div id="pg-resume" class="pg">
  <div class="pg-hdr">
    <h1>📄 AI Resume Analyzer</h1>
    <p style="color:var(--muted)">Match score • ATS check • Skills gap • AI recommendations</p>
  </div>
  <div class="two">
    <div>
      <div class="card" style="margin-bottom:14px">
        <h3>📋 Your Resume</h3>
        <textarea id="rTxt" rows="13" placeholder="Paste your complete resume text here...&#10;&#10;Include: Contact info, experience, skills, education"></textarea>
      </div>
      <div class="card">
        <h3>💼 Job Description</h3>
        <textarea id="jdTxt" rows="11" placeholder="Paste the full job description here...&#10;&#10;The more complete, the better the analysis"></textarea>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn btn-p" style="flex:1;justify-content:center" onclick="analyze()" id="aBtn">
            🔍 Analyze Match
          </button>
          <button class="btn btn-o btn-sm" onclick="saveResume()">💾 Save Resume</button>
        </div>
      </div>
    </div>
    <div id="rOut">
      <div class="card">
        <div class="empty"><div class="empty-ico">📊</div>
          <h3>Analysis Results</h3>
          <p style="margin-top:6px">Paste your resume and a job description, then click "Analyze Match"</p>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ══ TRACKER ══ -->
<div id="pg-apps" class="pg">
  <div class="pg-hdr">
    <h1>📋 Application Tracker</h1>
    <p style="color:var(--muted)">Track all your job applications in one kanban board</p>
  </div>
  <div class="kanban" id="kanban"></div>
</div>

<!-- ══ DASHBOARD ══ -->
<div id="pg-dash" class="pg">
  <div class="pg-hdr">
    <h1>📊 Dashboard</h1>
    <p style="color:var(--muted)">Your job search analytics and insights</p>
  </div>
  <div class="dash-cards" id="dCards">
    <div class="dc"><div class="dc-n" id="d0">0</div><div class="dc-l">Total Applications</div></div>
    <div class="dc"><div class="dc-n" id="d1">0</div><div class="dc-l">Saved Jobs</div></div>
    <div class="dc"><div class="dc-n" id="d2">0%</div><div class="dc-l">Response Rate</div></div>
    <div class="dc"><div class="dc-n" id="d3">0</div><div class="dc-l">Interviews</div></div>
    <div class="dc"><div class="dc-n" id="d4">0</div><div class="dc-l">Offers</div></div>
    <div class="dc"><div class="dc-n" id="d5">0</div><div class="dc-l">This Week</div></div>
  </div>
  <div class="card">
    <h3>💡 Job Search Tips That Work</h3>
    <ul class="tip-list" style="margin-top:12px">
      <li>⚡<span><strong>Apply in first 24 hours</strong> — response rate is 3x higher for early applicants</span></li>
      <li>🎯<span><strong>5-10 targeted apps/week</strong> beats 100 random ones every time</span></li>
      <li>📄<span><strong>Customize every resume</strong> — paste job description into Resume Analyzer first</span></li>
      <li>🤝<span><strong>Follow up after 7 days</strong> — politely ask about your application status</span></li>
      <li>💬<span><strong>Connect on LinkedIn</strong> with the hiring manager before applying</span></li>
      <li>🔔<span><strong>Save your search filters</strong> to get consistent results every day</span></li>
      <li>💰<span><strong>Always negotiate</strong> — 85% of employers expect it and have wiggle room</span></li>
    </ul>
  </div>
</div>

<!-- ══ NOTIFICATIONS ══ -->
<div id="pg-notifs" class="pg">
  <div class="pg-hdr">
    <h1>🔔 Notifications</h1>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <strong>Recent Notifications</strong>
      <button class="btn btn-o btn-sm" onclick="markAllRead()">Mark all read</button>
    </div>
    <div id="notifsOut">
      <div class="empty"><div class="empty-ico">🔔</div><p>No notifications yet</p></div>
    </div>
  </div>
</div>

<!-- ══ AUTH ══ -->
<div id="pg-auth" class="pg">
  <div class="auth-wrap">
    <div class="card" id="loginCard">
      <h2 style="text-align:center;margin-bottom:22px;font-size:22px">👤 Welcome Back</h2>
      <input class="auth-inp" id="lEmail" type="email" placeholder="Email address">
      <input class="auth-inp" id="lPass" type="password" placeholder="Password">
      <button class="btn btn-p" style="width:100%;justify-content:center;padding:13px" onclick="login()">Login →</button>
      <div class="auth-sw">No account? <span onclick="swAuth()">Sign up free</span></div>
    </div>
    <div class="card" id="regCard" style="display:none">
      <h2 style="text-align:center;margin-bottom:22px;font-size:22px">🚀 Create Account</h2>
      <input class="auth-inp" id="rName" type="text" placeholder="Full name">
      <input class="auth-inp" id="rEmail" type="email" placeholder="Email address">
      <input class="auth-inp" id="rPass" type="password" placeholder="Password (min 6 chars)">
      <button class="btn btn-p" style="width:100%;justify-content:center;padding:13px" onclick="register()">Create Account 🎉</button>
      <div class="auth-sw">Have account? <span onclick="swAuth()">Login</span></div>
    </div>
    <div class="card" id="profileCard" style="display:none">
      <h2 style="text-align:center;margin-bottom:22px;font-size:22px">⚙️ Your Profile</h2>
      <div id="profileInfo"></div>
      <button class="btn btn-r" style="width:100%;justify-content:center;margin-top:16px" onclick="logout()">Logout</button>
    </div>
  </div>
</div>

</div><!-- end pages -->

<!-- AI CHAT -->
<button class="chat-fab" onclick="toggleChat()" id="chatFab">🤖</button>
<div id="chatPnl" class="chat-pnl">
  <div class="chat-hd">
    <div>
      <h3>🤖 AI Career Assistant</h3>
      <p id="aiInfo">Connecting to best available AI...</p>
    </div>
    <button onclick="toggleChat()" style="background:rgba(255,255,255,.25);border:none;color:#fff;
      width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer">×</button>
  </div>
  <div id="chatMsgs" class="chat-msgs">
    <div class="cm bot">
      👋 Hi! I'm your AI career assistant.<br><br>
      I help with <strong>resumes, interviews, salary negotiation,</strong> and job search strategies.
      What do you need help with?
    </div>
  </div>
  <div class="chat-suggs" id="cSuggs">
    <button class="csugg" onclick="qChat('How to optimize my resume for ATS?')">ATS Tips</button>
    <button class="csugg" onclick="qChat('Remote interview tips 2026')">Interview Prep</button>
    <button class="csugg" onclick="qChat('How to negotiate salary?')">Salary Tips</button>
    <button class="csugg" onclick="qChat('What skills are most in demand?')">Top Skills</button>
  </div>
  <div class="ai-lbl" id="aiLbl">⚡ Powered by free AI</div>
  <div class="chat-ft">
    <input id="chatIn" type="text" placeholder="Ask anything about your job search..."
      onkeydown="if(event.key==='Enter')sendChat()">
    <button class="send" onclick="sendChat()">➤</button>
  </div>
</div>

<!-- JOB MODAL -->
<div class="modal-bg" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <button class="mcls" onclick="closeModal()">✕</button>
    <div id="modalBody"></div>
  </div>
</div>

<!-- TOAST CONTAINER -->
<div class="toasts" id="toasts"></div>

<script>
// ════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════
let token = localStorage.getItem('rh_tok') || '';
let user  = null;
let allJobs   = [];
let curPage   = 1;
let curFilters= {};
let convId    = null;
let activeSF  = null;
let isDark    = localStorage.getItem('rh_dark') === '1';
let appsList  = JSON.parse(localStorage.getItem('rh_apps') || '[]');
let savedIds  = new Set(JSON.parse(localStorage.getItem('rh_saved') || '[]'));

// ════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  if (isDark) { document.body.setAttribute('data-dark',''); document.getElementById('themeBtn').textContent = '☀️'; }
  checkSession();
  setTimeout(search, 400);
  loadPrefs();
  renderKanban();
  renderDash();
  loadNotifs();
});

// ════════════════════════════════════════════
// PAGE NAVIGATION
// ════════════════════════════════════════════
function pg(name, btn) {
  document.querySelectorAll('.pg').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  document.getElementById('pg-' + name).classList.add('on');
  if (btn) btn.classList.add('on');
  if (name === 'apps')   renderKanban();
  if (name === 'dash')   renderDash();
  if (name === 'auth')   renderAuthPage();
  if (name === 'notifs') loadNotifs();
}

// ════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════
function toggleDark() {
  isDark = !isDark;
  if (isDark) { document.body.setAttribute('data-dark',''); document.getElementById('themeBtn').textContent = '☀️'; }
  else { document.body.removeAttribute('data-dark'); document.getElementById('themeBtn').textContent = '🌙'; }
  localStorage.setItem('rh_dark', isDark ? '1' : '0');
}

// ════════════════════════════════════════════
// JOB SEARCH
// ════════════════════════════════════════════
async function search(append = false) {
  const kw      = document.getElementById('kw').value.trim();
  const skills  = document.getElementById('fSkills').value.split(',').map(s=>s.trim()).filter(Boolean);
  const exclKw  = document.getElementById('fExcKw').value.split(',').map(s=>s.trim()).filter(Boolean);

  curFilters = {
    keywords:           kw,
    remote_only:        document.getElementById('fRem').checked,
    usa_only:           document.getElementById('fUSA').checked,
    employment_type:    document.getElementById('fType').value,
    experience_level:   document.getElementById('fLvl').value,
    industry:           document.getElementById('fInd').value,
    company_size:       document.getElementById('fSize').value,
    exclude_leadership: document.getElementById('fNoLead').checked,
    exclude_staffing:   document.getElementById('fNoStaff').checked,
    exclude_government: document.getElementById('fNoGov').checked,
    visa_sponsorship:   document.getElementById('fVisa').checked || null,
    salary_min:         document.getElementById('fSalMin').value || null,
    salary_max:         document.getElementById('fSalMax').value || null,
    date_posted:        document.getElementById('fDate').value,
    skills,
    exclude_keywords:   exclKw,
    sort:               document.getElementById('fSort').value,
    page:               append ? curPage : 1
  };

  if (!append) { curPage = 1; allJobs = []; }

  const btn = document.getElementById('sBtn');
  btn.disabled = true;
  btn.textContent = '⏳';
  document.getElementById('ldState').style.display = 'block';
  if (!append) {
    document.getElementById('jList').innerHTML = '';
    document.getElementById('sBar').style.display = 'none';
    document.getElementById('ldMore').style.display = 'none';
  }

  // Animated loading messages
  const msgs = [
    'Connecting to RemoteOK...','Fetching from Remotive...','Searching The Muse...',
    'Scanning Arbeitnow...','Checking Findwork...','Looking on Jobicy...','Applying AI filters...'
  ];
  let mi = 0;
  const mEl = document.getElementById('ldMsg');
  const mInt = setInterval(() => { if (mi < msgs.length) mEl.textContent = msgs[mi++]; else clearInterval(mInt); }, 900);

  try {
    const p = new URLSearchParams();
    Object.entries(curFilters).forEach(([k,v]) => {
      if (v !== null && v !== '' && v !== false && v !== undefined) {
        if (Array.isArray(v) && v.length > 0) p.set(k, v.join(','));
        else if (!Array.isArray(v)) p.set(k, v);
      }
    });

    const res = await fetch('/api/jobs/search?' + p, {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    const data = await res.json();
    clearInterval(mInt);

    if (data.success) {
      if (append) allJobs = [...allJobs, ...data.jobs];
      else allJobs = data.jobs;

      renderJobs(data.jobs, append);
      renderStats(data.total, data.sources);
      if (data.hasMore) { document.getElementById('ldMore').style.display = 'block'; curPage++; }
      else document.getElementById('ldMore').style.display = 'none';
    } else toast(data.error || 'Search failed', 'e');
  } catch(e) {
    clearInterval(mInt);
    toast('Network error - showing demo data', 'w');
    renderDemo();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
    document.getElementById('ldState').style.display = 'none';
  }
}

function more() { search(true); }
function qs(q) { document.getElementById('kw').value = q; search(); }

// ════════════════════════════════════════════
// SMART FILTERS
// ════════════════════════════════════════════
const sfMap = ['sf0','sf1','sf2','sf3','sf4'];
function smart(type) {
  const idx = ['best_match','high_salary','easy_apply','fast_growing','low_competition'].indexOf(type);
  if (activeSF === type) {
    sfMap.forEach(id => document.getElementById(id)?.classList.remove('on'));
    activeSF = null; resetAll(false); return;
  }
  sfMap.forEach(id => document.getElementById(id)?.classList.remove('on'));
  document.getElementById(sfMap[idx])?.classList.add('on');
  activeSF = type;

  const actions = {
    best_match:      () => { document.getElementById('fSort').value = 'match'; },
    high_salary:     () => { document.getElementById('fSalMin').value = '100000'; document.getElementById('fSort').value = 'salary'; },
    easy_apply:      () => { document.getElementById('fDate').value = 'week'; },
    fast_growing:    () => { curFilters.fast_growing = true; },
    low_competition: () => { document.getElementById('fDate').value = 'today'; curFilters.low_competition = true; }
  };
  actions[type]?.();
  search();
}

// ════════════════════════════════════════════
// FILTERS RESET & SAVE
// ════════════════════════════════════════════
function resetAll(doSearch = true) {
  ['fType','fLvl','fInd','fSize'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('fDate').value = 'week';
  document.getElementById('fSort').value = 'date';
  ['fSkills','fExcKw','fSalMin','fSalMax'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('fRem').checked = true;
  document.getElementById('fUSA').checked = false;
  document.getElementById('fNoLead').checked = true;
  document.getElementById('fNoStaff').checked = true;
  document.getElementById('fNoGov').checked = false;
  document.getElementById('fVisa').checked = false;
  sfMap.forEach(id => document.getElementById(id)?.classList.remove('on'));
  activeSF = null;
  if (doSearch) search();
}

function savePrefs() {
  const prefs = {
    remote_only: document.getElementById('fRem').checked,
    usa_only: document.getElementById('fUSA').checked,
    employment_type: document.getElementById('fType').value,
    experience_level: document.getElementById('fLvl').value,
    industry: document.getElementById('fInd').value,
    date_posted: document.getElementById('fDate').value,
    skills: document.getElementById('fSkills').value.split(',').map(s=>s.trim()).filter(Boolean),
    excluded_keywords: document.getElementById('fExcKw').value.split(',').map(s=>s.trim()).filter(Boolean),
    salary_min: document.getElementById('fSalMin').value || null,
    exclude_leadership: document.getElementById('fNoLead').checked,
    exclude_staffing: document.getElementById('fNoStaff').checked
  };
  localStorage.setItem('rh_prefs', JSON.stringify(prefs));

  if (token) {
    fetch('/api/auth/preferences', {
      method: 'PUT',
      headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token },
      body: JSON.stringify(prefs)
    }).catch(() => {});
  }
  toast('Preferences saved! 💾', 's');
}

function loadPrefs() {
  const p = JSON.parse(localStorage.getItem('rh_prefs') || '{}');
  if (!p || !Object.keys(p).length) return;
  if (p.remote_only !== undefined) document.getElementById('fRem').checked = p.remote_only;
  if (p.usa_only !== undefined) document.getElementById('fUSA').checked = p.usa_only;
  if (p.employment_type) document.getElementById('fType').value = p.employment_type;
  if (p.experience_level) document.getElementById('fLvl').value = p.experience_level;
  if (p.industry) document.getElementById('fInd').value = p.industry;
  if (p.date_posted) document.getElementById('fDate').value = p.date_posted;
  if (p.skills?.length) document.getElementById('fSkills').value = p.skills.join(', ');
  if (p.excluded_keywords?.length) document.getElementById('fExcKw').value = p.excluded_keywords.join(', ');
  if (p.salary_min) document.getElementById('fSalMin').value = p.salary_min;
  if (p.exclude_leadership !== undefined) document.getElementById('fNoLead').checked = p.exclude_leadership;
  if (p.exclude_staffing !== undefined) document.getElementById('fNoStaff').checked = p.exclude_staffing;
}

// ════════════════════════════════════════════
// RENDER JOBS
// ════════════════════════════════════════════
function renderJobs(jobs, append) {
  const c = document.getElementById('jList');
  if (!append) c.innerHTML = '';

  if (!jobs.length && !append) {
    c.innerHTML = '<div class="empty"><div class="empty-ico">🔍</div><h3>No jobs found</h3><p style="margin-top:6px">Try different keywords or adjust your filters</p></div>';
    return;
  }

  jobs.forEach((j, i) => {
    const idx = append ? allJobs.length - jobs.length + i : i;
    window['_j' + idx] = j;

    const age = Math.floor((Date.now() - new Date(j.posted_date)) / 86400000);
    const isNew = age < 2;
    const saved = savedIds.has(j.id);
    const init = (j.company || 'J').charAt(0).toUpperCase();

    const el = document.createElement('div');
    el.className = 'jcard';
    el.onclick = () => openModal(j);
    el.innerHTML = \`
      <div class="jc-top">
        \${j.logo
          ? \`<img class="co-logo" src="\${j.logo}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">\`
          : ''
        }
        <div class="co-init" \${j.logo ? 'style="display:none"' : ''}>\${init}</div>
        <div class="jc-inf">
          <div class="jc-title">\${esc(j.title)}</div>
          <div class="jc-co">\${esc(j.company)}</div>
        </div>
        <div class="jc-score">⚡ \${j.match_score || 0}%</div>
      </div>
      <div class="meta">
        <span>📍 \${esc(j.location)}</span>
        \${isNew ? '<span class="pill p-new">✨ New</span>' : ''}
        \${j.remote ? '<span class="pill p-rem">🏠 Remote</span>' : ''}
        \${j.salary_raw ? \`<span class="pill p-sal">💰 \${esc(j.salary_raw)}</span>\` : ''}
        \${j.employment_type ? \`<span class="pill p-typ">\${esc(j.employment_type)}</span>\` : ''}
        <span>🕐 \${age === 0 ? 'Today' : age + 'd ago'}</span>
        \${j.applicants > 0 ? \`<span>👥 \${j.applicants} applied</span>\` : ''}
      </div>
      <div class="jdesc">\${esc((j.description||'').slice(0,200))}...</div>
      \${j.skills?.length > 0 ? \`
        <div class="stags">
          \${j.skills.slice(0,7).map(s => \`<span class="stag">\${esc(s)}</span>\`).join('')}
          \${j.skills.length > 7 ? \`<span class="stag">+\${j.skills.length-7}</span>\` : ''}
        </div>
      \` : ''}
      <div class="jfoot">
        <span class="jsrc">\${j.source_icon||'🌐'} \${esc(j.source)}</span>
        <div class="jacts">
          <button class="sv-btn \${saved ? 'on' : ''}" data-jid="\${j.id}"
            onclick="event.stopPropagation();toggleSave(this,window._j\${idx})"
            title="\${saved ? 'Remove from saved' : 'Save job'}">\${saved ? '❤️' : '🤍'}</button>
          <button class="btn btn-o btn-sm"
            onclick="event.stopPropagation();trackJob(window._j\${idx})">📋 Track</button>
          <a href="\${esc(j.apply_url || j.url || '#')}" target="_blank" rel="noopener"
            class="btn btn-p btn-sm" onclick="event.stopPropagation()">Apply →</a>
        </div>
      </div>
    \`;
    c.appendChild(el);
  });
}

function renderStats(total, sources) {
  document.getElementById('sBar').style.display = 'flex';
  document.getElementById('sNum').textContent = total;
  document.getElementById('srcTags').innerHTML = (sources || [])
    .filter(s => s.count > 0)
    .map(s => \`<span class="src-tag">✅ \${s.name}: \${s.count}</span>\`)
    .join('');
}

function renderDemo() {
  const demos = [
    { id:'d1', title:'Senior React Developer', company:'TechCorp Inc', logo:null, location:'Remote, US', source:'Demo', source_icon:'📋', remote:true, salary_raw:'$120k-$160k/yr', employment_type:'Full-time', description:'We are looking for an experienced React developer to join our fully remote team. You will work on cutting-edge projects with modern tech stack...', skills:['react','typescript','nodejs','graphql','aws'], posted_date: new Date().toISOString(), apply_url:'#', match_score:88 },
    { id:'d2', title:'Python Backend Engineer', company:'DataStartup', logo:null, location:'Remote', source:'Demo', source_icon:'📋', remote:true, salary_raw:'$100k-$140k/yr', employment_type:'Full-time', description:'Join our growing team as a Python backend engineer. Work on ML pipelines, APIs, and data infrastructure in a fast-paced startup environment...', skills:['python','fastapi','aws','docker','postgresql'], posted_date:new Date(Date.now()-86400000).toISOString(), apply_url:'#', match_score:74 },
    { id:'d3', title:'UX/Product Designer', company:'SaaSCo', logo:null, location:'Remote', source:'Demo', source_icon:'📋', remote:true, salary_raw:null, employment_type:'Contract', description:'Design beautiful and intuitive user experiences for our B2B SaaS platform. Work closely with product and engineering teams...', skills:['figma','sketch','prototyping','user research'], posted_date:new Date(Date.now()-172800000).toISOString(), apply_url:'#', match_score:62 }
  ];
  allJobs = demos;
  demos.forEach((j,i) => window['_j'+i] = j);
  renderJobs(demos, false);
  renderStats(3, [{name:'Demo Data',count:3}]);
}

// ════════════════════════════════════════════
// MODAL
// ════════════════════════════════════════════
function openModal(j) {
  const age = Math.floor((Date.now() - new Date(j.posted_date)) / 86400000);
  document.getElementById('modalBody').innerHTML = \`
    <h2 style="font-size:22px;font-weight:800;margin-bottom:6px;padding-right:40px">\${esc(j.title)}</h2>
    <p style="color:var(--muted);font-size:15px;margin-bottom:14px">\${esc(j.company)} · \${esc(j.location)}</p>
    <div class="meta" style="margin-bottom:16px">
      \${j.remote ? '<span class="pill p-rem">🏠 Remote</span>' : ''}
      \${j.salary_raw ? \`<span class="pill p-sal">💰 \${esc(j.salary_raw)}</span>\` : ''}
      \${j.employment_type ? \`<span class="pill p-typ">\${esc(j.employment_type)}</span>\` : ''}
      <span class="pill" style="background:var(--bg);color:var(--muted)">🕐 \${age === 0 ? 'Today' : age + 'd ago'}</span>
      <span class="pill" style="background:linear-gradient(135deg,var(--p),var(--s));color:#fff">⚡ \${j.match_score||0}% Match</span>
    </div>
    \${j.skills?.length > 0 ? \`
      <div style="margin-bottom:18px">
        <strong style="font-size:14px">🎯 Required Skills</strong>
        <div class="stags" style="margin-top:8px">
          \${j.skills.map(s => \`<span class="stag" style="font-size:13px">\${esc(s)}</span>\`).join('')}
        </div>
      </div>
    \` : ''}
    <div style="margin-bottom:22px">
      <strong style="font-size:14px">📋 Description</strong>
      <div style="font-size:14px;line-height:1.8;color:var(--muted);margin-top:8px;white-space:pre-wrap">
        \${esc(j.description.slice(0,2000))}\${j.description.length > 2000 ? '...' : ''}
      </div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:18px">
      <a href="\${esc(j.apply_url||j.url||'#')}" target="_blank" rel="noopener" class="btn btn-p">🚀 Apply Now</a>
      <button class="btn btn-o" onclick="closeModal();document.getElementById('jdTxt').value=\`\${esc(j.description)}\`;pg('resume',document.querySelectorAll('.tab')[1])">
        📄 Analyze My Match
      </button>
      <button class="btn btn-o" onclick="trackJob(j);closeModal()">📋 Track Application</button>
      <button class="btn btn-o" onclick="closeModal();qChat('Tips for applying to \${esc(j.title)} at \${esc(j.company)}')">🤖 AI Tips</button>
    </div>
  \`;
  window._modalJob = j;
  document.getElementById('modal').classList.add('on');
}

function closeModal() { document.getElementById('modal').classList.remove('on'); }

// ════════════════════════════════════════════
// SAVE JOBS
// ════════════════════════════════════════════
function toggleSave(btn, j) {
  if (!j) return;
  if (savedIds.has(j.id)) {
    savedIds.delete(j.id);
    btn.innerHTML = '🤍'; btn.classList.remove('on');
    toast('Removed from saved', 'i');
    if (token) fetch('/api/jobs/save/' + j.id, { method:'DELETE', headers:{Authorization:'Bearer '+token} }).catch(()=>{});
  } else {
    savedIds.add(j.id);
    btn.innerHTML = '❤️'; btn.classList.add('on');
    toast('Job saved! ❤️', 's');
    if (token) fetch('/api/jobs/save', {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},
      body: JSON.stringify({ job: j })
    }).catch(()=>{});
  }
  localStorage.setItem('rh_saved', JSON.stringify([...savedIds]));
  renderDash();
}

// ════════════════════════════════════════════
// APPLICATION TRACKER
// ════════════════════════════════════════════
function trackJob(j) {
  if (!j) return;
  if (appsList.find(a => a.jobId === j.id)) { toast('Already tracking this application', 'i'); return; }
  appsList.push({
    id: 'app_' + Date.now(),
    jobId: j.id, job: j,
    status: 'applied',
    appliedDate: new Date().toISOString(),
    timeline: [{ status:'applied', date:new Date().toISOString() }]
  });
  localStorage.setItem('rh_apps', JSON.stringify(appsList));
  toast('Application tracked! 📋', 's');
  renderDash();

  if (token) {
    fetch('/api/applications', {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},
      body: JSON.stringify({ job: j })
    }).catch(()=>{});
  }
}

function renderKanban() {
  const cols = [
    { key:'applied',      label:'📨 Applied',      color:'#6366f1' },
    { key:'viewed',       label:'👀 Viewed',        color:'#f59e0b' },
    { key:'interviewing', label:'🎤 Interviewing',  color:'#06b6d4' },
    { key:'offered',      label:'🎉 Offered',       color:'#10b981' },
    { key:'rejected',     label:'❌ Rejected',      color:'#ef4444' }
  ];
  const board = document.getElementById('kanban');
  if (!board) return;

  if (!appsList.length) {
    board.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-ico">📋</div><h3>No applications yet</h3><p style="margin-top:6px">Click "📋 Track" on any job card to add it here</p></div>';
    return;
  }

  board.innerHTML = cols.map(col => {
    const items = appsList.filter(a => a.status === col.key);
    return \`
      <div class="kcol">
        <div class="kcol-title" style="color:\${col.color}">\${col.label} <span style="background:var(--bg);padding:2px 8px;border-radius:20px;font-size:12px">\${items.length}</span></div>
        \${items.length === 0
          ? '<p style="font-size:12px;color:var(--muted);text-align:center;padding:16px 0">Empty</p>'
          : items.map(a => \`
            <div class="kcard">
              <h4>\${esc(a.job.title)}</h4>
              <p>\${esc(a.job.company)}</p>
              <div class="kcard-date">Applied: \${new Date(a.appliedDate).toLocaleDateString()}</div>
              <div class="kcard-actions">
                <select style="font-size:11px;padding:3px 6px;border:1px solid var(--border);border-radius:5px;background:var(--bg);color:var(--text)"
                  onchange="updateStatus('\${a.id}',this.value)">
                  \${cols.map(c => \`<option value="\${c.key}" \${a.status===c.key?'selected':''}>\${c.label}</option>\`).join('')}
                </select>
                <a href="\${esc(a.job.apply_url||a.job.url||'#')}" target="_blank"
                  style="font-size:11px;padding:3px 8px;background:var(--p);color:#fff;border-radius:5px">Apply</a>
                <button style="font-size:11px;padding:3px 6px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:5px;cursor:pointer"
                  onclick="removeApp('\${a.id}')">✕</button>
              </div>
            </div>
          \`).join('')
        }
      </div>
    \`;
  }).join('');
}

function updateStatus(id, status) {
  const app = appsList.find(a => a.id === id);
  if (!app) return;
  app.status = status;
  app.timeline = [...(app.timeline||[]), { status, date:new Date().toISOString() }];
  localStorage.setItem('rh_apps', JSON.stringify(appsList));
  renderKanban(); renderDash();
  toast('Status updated ✓', 's');
}

function removeApp(id) {
  appsList = appsList.filter(a => a.id !== id);
  localStorage.setItem('rh_apps', JSON.stringify(appsList));
  renderKanban(); renderDash();
}

// ════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════
function renderDash() {
  const total   = appsList.length;
  const intrvws = appsList.filter(a => ['interviewing','offered','accepted'].includes(a.status)).length;
  const offers  = appsList.filter(a => a.status === 'offered').length;
  const rate    = total > 0 ? Math.round(intrvws/total*100) : 0;
  const week    = appsList.filter(a => Date.now()-new Date(a.appliedDate) < 604800000).length;
  ['d0','d1','d2','d3','d4','d5'].forEach((id,i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = [total, savedIds.size, rate+'%', intrvws, offers, week][i];
  });
}

// ════════════════════════════════════════════
// RESUME ANALYZER
// ════════════════════════════════════════════
async function analyze() {
  const resume = document.getElementById('rTxt').value.trim();
  const jd     = document.getElementById('jdTxt').value.trim();
  if (!resume || !jd) { toast('Please provide both resume and job description', 'e'); return; }

  const btn = document.getElementById('aBtn');
  btn.textContent = '⏳ Analyzing...';
  btn.disabled = true;
  document.getElementById('rOut').innerHTML = '<div class="card ld"><div class="spin"></div><p>AI is analyzing your resume...</p></div>';

  try {
    const res = await fetch('/api/resume/analyze', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ resumeText:resume, jobDescription:jd })
    });
    const data = await res.json();
    if (data.success) { renderAnalysis(data.analysis); toast('Analysis complete! 📊', 's'); }
    else toast(data.error || 'Analysis failed', 'e');
  } catch(e) {
    toast('Failed to connect to server', 'e');
    document.getElementById('rOut').innerHTML = '<div class="card empty"><div class="empty-ico">❌</div><p>Analysis failed. Check your connection.</p></div>';
  } finally {
    btn.textContent = '🔍 Analyze Match';
    btn.disabled = false;
  }
}

function renderAnalysis(a) {
  const s = a.overall || 0;
  const c = s >= 75 ? '#10b981' : s >= 55 ? '#f59e0b' : '#ef4444';
  const lbl = s >= 85 ? 'Excellent Match' : s >= 70 ? 'Good Match' : s >= 50 ? 'Fair Match' : 'Needs Work';
  const circ = 2 * Math.PI * 52;
  const off = circ - (s/100)*circ;

  document.getElementById('rOut').innerHTML = \`
    <div class="card" style="margin-bottom:14px;text-align:center">
      <h3 style="justify-content:center">🎯 Overall Match Score</h3>
      <div class="ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border)" stroke-width="10"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="\${c}" stroke-width="10"
            stroke-dasharray="\${circ}" stroke-dashoffset="\${off}" stroke-linecap="round"
            style="transition:stroke-dashoffset 1.4s ease"/>
        </svg>
        <div class="ring-txt">
          <div class="ring-n" style="color:\${c}">\${s}%</div>
          <div class="ring-l">\${lbl}</div>
        </div>
      </div>
      <div class="sub-scores">
        \${[['Tech','techScore','#6366f1'],['Soft','softScore','#06b6d4'],['ATS','atsScore','#10b981']].map(([l,k,col]) => \`
          <div class="ss">
            <div class="ss-n" style="color:\${col}">\${a[k]||0}%</div>
            <div class="ss-l">\${l}</div>
            <div class="pbar"><div class="pfill" style="width:\${a[k]||0}%;background:\${col}"></div></div>
          </div>
        \`).join('')}
      </div>
    </div>

    \${a.matching?.length > 0 ? \`
      <div class="card" style="margin-bottom:14px">
        <h3>✅ Matching Skills (\${a.matching.length})</h3>
        <div class="skills-wrap">\${a.matching.map(s => \`<span class="sk sk-y">\${esc(s)}</span>\`).join('')}</div>
      </div>
    \` : ''}

    \${a.missing?.length > 0 ? \`
      <div class="card" style="margin-bottom:14px">
        <h3>❌ Missing Skills (\${a.missing.length})</h3>
        <div class="skills-wrap">\${a.missing.map(s => \`<span class="sk sk-n">\${esc(s)}</span>\`).join('')}</div>
      </div>
    \` : ''}

    \${a.extra?.length > 0 ? \`
      <div class="card" style="margin-bottom:14px">
        <h3>⭐ Your Extra Skills (\${a.extra.length})</h3>
        <div class="skills-wrap">\${a.extra.slice(0,12).map(s => \`<span class="sk sk-e">\${esc(s)}</span>\`).join('')}</div>
      </div>
    \` : ''}

    \${a.improvements?.length > 0 ? \`
      <div class="card" style="margin-bottom:14px">
        <h3>💡 How to Improve</h3>
        <ul class="tip-list" style="margin-top:10px">
          \${a.improvements.map(t => \`<li>💡 <span>\${esc(t)}</span></li>\`).join('')}
        </ul>
      </div>
    \` : ''}

    \${a.ats ? \`
      <div class="card" style="margin-bottom:14px">
        <h3>🤖 ATS Checklist</h3>
        <div class="ats-grid" style="margin-top:10px">
          \${Object.entries(a.ats).map(([k,v]) => \`
            <div class="ats-item">\${v ? '✅' : '❌'} \${esc(k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()))}</div>
          \`).join('')}
        </div>
      </div>
    \` : ''}

    \${a.aiAnalysis ? \`
      <div class="card">
        <h3>🤖 AI Analysis</h3>
        <p style="font-size:13px;line-height:1.8;color:var(--muted);margin-top:10px">\${esc(a.aiAnalysis)}</p>
      </div>
    \` : ''}
  \`;
}

function saveResume() {
  const content = document.getElementById('rTxt').value.trim();
  if (!content) { toast('No resume to save', 'e'); return; }

  if (token) {
    const title = 'Resume ' + new Date().toLocaleDateString();
    fetch('/api/resume/save', {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},
      body: JSON.stringify({ title, content })
    }).then(() => toast('Resume saved to your account! 💾', 's')).catch(() => toast('Save failed', 'e'));
  } else {
    localStorage.setItem('rh_resume', content);
    toast('Resume saved locally 💾', 's');
  }
}

// ════════════════════════════════════════════
// AI CHAT
// ════════════════════════════════════════════
async function toggleChat() {
  const p = document.getElementById('chatPnl');
  p.classList.toggle('on');
  if (p.classList.contains('on')) {
    try {
      const r = await fetch('/api/health');
      const d = await r.json();
      const prov = d.ai?.active || 'Local';
      document.getElementById('aiInfo').textContent = 'AI: ' + prov + ' (Free)';
      document.getElementById('aiLbl').textContent = '⚡ ' + prov + ' • Free Forever';
    } catch {}
  }
}

async function sendChat() {
  const inp = document.getElementById('chatIn');
  const msg = inp.value.trim();
  if (!msg) return;

  addChatMsg(msg, 'user');
  inp.value = '';
  inp.disabled = true;

  const typId = 'ty_' + Date.now();
  const msgs = document.getElementById('chatMsgs');
  msgs.innerHTML += \`<div id="\${typId}" class="cm bot"><div class="typing-dots"><span></span><span></span><span></span></div></div>\`;
  msgs.scrollTop = msgs.scrollHeight;

  try {
    const r = await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:msg, conversationId:convId })
    });
    const d = await r.json();
    document.getElementById(typId)?.remove();

    if (d.success) {
      convId = d.conversationId;
      addChatMsg(d.response.text, 'bot');
      document.getElementById('aiInfo').textContent = 'AI: ' + d.response.provider;
    }
  } catch {
    document.getElementById(typId)?.remove();
    addChatMsg('Connection error. Please try again.', 'bot');
  } finally {
    inp.disabled = false;
    inp.focus();
  }
}

function qChat(msg) {
  document.getElementById('chatIn').value = msg;
  document.getElementById('cSuggs').style.display = 'none';
  if (!document.getElementById('chatPnl').classList.contains('on')) toggleChat();
  sendChat();
}

function addChatMsg(text, role) {
  const msgs = document.getElementById('chatMsgs');
  const d = document.createElement('div');
  d.className = 'cm ' + role;
  d.innerHTML = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\n/g,'<br>')
    .replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\*(.*?)\\*/g,'<em>$1</em>')
    .replace(/•/g,'•');
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

// ════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════
async function login() {
  const email = document.getElementById('lEmail').value;
  const pass  = document.getElementById('lPass').value;
  if (!email || !pass) { toast('Please fill all fields', 'e'); return; }

  try {
    const r = await fetch('/api/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password:pass })
    });
    const d = await r.json();
    if (d.success) {
      token = d.token; user = d.user;
      localStorage.setItem('rh_tok', token);
      toast('Welcome back, ' + user.name + '! 👋', 's');
      renderAuthPage();
      pg('search', document.querySelector('.tab'));
    } else toast(d.error || 'Login failed', 'e');
  } catch(e) { toast('Login failed: ' + e.message, 'e'); }
}

async function register() {
  const name  = document.getElementById('rName').value;
  const email = document.getElementById('rEmail').value;
  const pass  = document.getElementById('rPass').value;
  if (!name||!email||!pass) { toast('Please fill all fields', 'e'); return; }
  if (pass.length < 6) { toast('Password needs 6+ characters', 'e'); return; }

  try {
    const r = await fetch('/api/auth/register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, email, password:pass })
    });
    const d = await r.json();
    if (d.success) {
      token = d.token; user = d.user;
      localStorage.setItem('rh_tok', token);
      toast('Welcome to RemoteHunt, ' + name + '! 🎉', 's');
      renderAuthPage();
      pg('search', document.querySelector('.tab'));
    } else toast(d.error || 'Registration failed', 'e');
  } catch(e) { toast('Registration failed: ' + e.message, 'e'); }
}

async function checkSession() {
  if (!token) return;
  try {
    const r = await fetch('/api/auth/me', { headers:{ Authorization:'Bearer '+token } });
    const d = await r.json();
    if (d.success) { user = d.user; renderAuthPage(); }
    else { token = ''; localStorage.removeItem('rh_tok'); }
  } catch {}
}

function logout() {
  token = ''; user = null;
  localStorage.removeItem('rh_tok');
  renderAuthPage();
  toast('Logged out', 'i');
  pg('search', document.querySelector('.tab'));
}

function swAuth() {
  const l = document.getElementById('loginCard');
  const r = document.getElementById('regCard');
  l.style.display = l.style.display === 'none' ? '' : 'none';
  r.style.display = r.style.display === 'none' ? '' : 'none';
}

function renderAuthPage() {
  const btn = document.getElementById('authBtn');
  if (user) {
    btn.textContent = (user.name||'U').charAt(0).toUpperCase();
    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('regCard').style.display = 'none';
    document.getElementById('profileCard').style.display = '';
    document.getElementById('profileInfo').innerHTML = \`
      <div style="text-align:center;margin-bottom:20px">
        <div style="width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,var(--p),var(--s));
          color:#fff;font-size:28px;font-weight:700;display:flex;align-items:center;
          justify-content:center;margin:0 auto 12px">\${user.name.charAt(0).toUpperCase()}</div>
        <h3>\${esc(user.name)}</h3>
        <p style="color:var(--muted);font-size:14px">\${esc(user.email)}</p>
      </div>
      <div style="display:grid;gap:8px;font-size:14px">
        <div style="display:flex;justify-content:space-between;padding:10px;background:var(--bg);border-radius:8px">
          <span>Applications</span><strong>\${appsList.length}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:10px;background:var(--bg);border-radius:8px">
          <span>Saved Jobs</span><strong>\${savedIds.size}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:10px;background:var(--bg);border-radius:8px">
          <span>Member Since</span><strong>\${new Date(user.createdAt).toLocaleDateString()}</strong>
        </div>
      </div>
    \`;
  } else {
    btn.textContent = '👤';
    document.getElementById('profileCard').style.display = 'none';
    document.getElementById('loginCard').style.display = '';
    document.getElementById('regCard').style.display = 'none';
  }
}

// ════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════
async function loadNotifs() {
  if (!token) {
    document.getElementById('notifsOut').innerHTML = '<div class="empty"><p>Login to see notifications</p></div>';
    return;
  }
  try {
    const r = await fetch('/api/notifications', { headers:{ Authorization:'Bearer '+token } });
    const d = await r.json();
    if (d.success) {
      const badge = document.getElementById('nBadge');
      if (d.unread > 0) { badge.style.display = 'flex'; badge.textContent = d.unread; }
      else badge.style.display = 'none';

      const out = document.getElementById('notifsOut');
      if (!d.notifications.length) {
        out.innerHTML = '<div class="empty"><div class="empty-ico">🔔</div><p>No notifications yet</p></div>';
        return;
      }
      out.innerHTML = d.notifications.map(n => \`
        <div style="padding:12px;border-bottom:1px solid var(--border);
          \${!n.read ? 'background:rgba(99,102,241,.04)' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <strong style="font-size:14px">\${esc(n.title)}</strong>
            <span style="font-size:11px;color:var(--muted)">\${new Date(n.createdAt).toLocaleDateString()}</span>
          </div>
          \${n.message ? \`<p style="font-size:13px;color:var(--muted);margin-top:4px">\${esc(n.message)}</p>\` : ''}
        </div>
      \`).join('');
    }
  } catch {}
}

async function markAllRead() {
  if (!token) return;
  await fetch('/api/notifications/read-all', { method:'PUT', headers:{ Authorization:'Bearer '+token } }).catch(()=>{});
  document.getElementById('nBadge').style.display = 'none';
  toast('All notifications marked as read', 's');
  loadNotifs();
}

// ════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════
function toast(msg, type = 'i') {
  const c = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icons = { s:'✅', e:'❌', i:'ℹ️', w:'⚠️' };
  el.innerHTML = (icons[type]||'ℹ️') + ' ' + msg;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(-20px)'; el.style.transition='.3s'; }, 3200);
  setTimeout(() => el.remove(), 3500);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(\`
╔══════════════════════════════════════════╗
║  🚀 REMOTEHUNT 2026 - LIVE & RUNNING    ║
║  Port: \${PORT}                              ║
║  URL:  http://localhost:\${PORT}              ║
╚══════════════════════════════════════════╝\`);
});
