// ============================================================
// REMOTEHUNT 2026 - COMPLETE PRODUCTION APP
// Advanced AI Job Search Platform
// ============================================================

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 1800 });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ============================================================
// IN-MEMORY DATABASE (Works with no setup)
// ============================================================

const Database = {
  users: new Map(),
  applications: new Map(),
  savedJobs: new Map(),
  savedSearches: new Map(),
  chatHistory: new Map(),
  resumes: new Map(),
  notifications: new Map(),

  // Users
  createUser(data) {
    const user = { ...data, id: uuidv4(), createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    return user;
  },
  findUserByEmail(email) {
    return [...this.users.values()].find(u => u.email === email);
  },
  findUserById(id) {
    return this.users.get(id);
  },
  updateUser(id, data) {
    const user = this.users.get(id);
    if (user) {
      const updated = { ...user, ...data, updatedAt: new Date().toISOString() };
      this.users.set(id, updated);
      return updated;
    }
    return null;
  },

  // Applications
  addApplication(data) {
    const app = { ...data, id: uuidv4(), createdAt: new Date().toISOString() };
    this.applications.set(app.id, app);
    return app;
  },
  getUserApplications(userId) {
    return [...this.applications.values()]
      .filter(a => a.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  updateApplication(id, data) {
    const app = this.applications.get(id);
    if (app) {
      const updated = { ...app, ...data, updatedAt: new Date().toISOString() };
      this.applications.set(id, updated);
      return updated;
    }
    return null;
  },

  // Saved Jobs
  saveJob(data) {
    const key = `${data.userId}_${data.jobId}`;
    if (this.savedJobs.has(key)) return null;
    const saved = { ...data, id: uuidv4(), savedAt: new Date().toISOString() };
    this.savedJobs.set(key, saved);
    return saved;
  },
  unsaveJob(userId, jobId) {
    const key = `${userId}_${jobId}`;
    this.savedJobs.delete(key);
  },
  getSavedJobs(userId) {
    return [...this.savedJobs.values()].filter(s => s.userId === userId);
  },

  // Resumes
  saveResume(data) {
    const resume = { ...data, id: uuidv4(), createdAt: new Date().toISOString() };
    const userResumes = this.resumes.get(data.userId) || [];
    userResumes.push(resume);
    this.resumes.set(data.userId, userResumes);
    return resume;
  },
  getUserResumes(userId) {
    return this.resumes.get(userId) || [];
  },

  // Notifications
  addNotification(userId, data) {
    const notifications = this.notifications.get(userId) || [];
    notifications.unshift({ ...data, id: uuidv4(), read: false, createdAt: new Date().toISOString() });
    this.notifications.set(userId, notifications.slice(0, 50));
  },
  getNotifications(userId) {
    return this.notifications.get(userId) || [];
  },
  markRead(userId, notificationId) {
    const notifications = this.notifications.get(userId) || [];
    const updated = notifications.map(n => n.id === notificationId ? { ...n, read: true } : n);
    this.notifications.set(userId, updated);
  }
};

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'remotehunt_secret_2026');
    req.user = Database.findUserById(decoded.userId);
    if (!req.user) return res.status(401).json({ success: false, error: 'Invalid token' });
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'remotehunt_secret_2026');
      req.user = Database.findUserById(decoded.userId);
    } catch {}
  }
  next();
}

// ============================================================
// JOB AGGREGATOR - ALL FREE SOURCES
// ============================================================

class JobAggregator {

  async fetchAllJobs(filters) {
    const cacheKey = `jobs_${JSON.stringify(filters)}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('📦 Cache hit');
      return cached;
    }

    console.log('🔍 Fetching from all sources...');

    const sources = await Promise.allSettled([
      this.fetchRemoteOK(filters),
      this.fetchRemotive(filters),
      this.fetchTheMuse(filters),
      this.fetchArbeitnow(filters),
      this.fetchFindwork(filters),
      this.fetchJobicy(filters)
    ]);

    let allJobs = [];
    const sourceStats = [];

    sources.forEach((result, i) => {
      const sourceNames = ['RemoteOK', 'Remotive', 'The Muse', 'Arbeitnow', 'Findwork', 'Jobicy'];
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        allJobs = allJobs.concat(result.value);
        sourceStats.push({ name: sourceNames[i], count: result.value.length, status: 'ok' });
      } else {
        sourceStats.push({ name: sourceNames[i], count: 0, status: 'error' });
      }
    });

    // Process jobs
    allJobs = this.normalize(allJobs);
    allJobs = this.applyFilters(allJobs, filters);
    allJobs = this.deduplicate(allJobs);
    allJobs = this.scoreJobs(allJobs, filters);
    allJobs = this.sort(allJobs, filters.sort || 'date');

    const result = {
      jobs: allJobs,
      total: allJobs.length,
      sources: sourceStats
    };

    cache.set(cacheKey, result);
    console.log(`✅ Total: ${allJobs.length} jobs from ${sourceStats.filter(s=>s.status==='ok').length} sources`);
    return result;
  }

  async fetchRemoteOK(filters) {
    try {
      const res = await axios.get('https://remoteok.com/api', {
        headers: { 'User-Agent': 'RemoteHunt/2.0 Job Aggregator' },
        timeout: 12000
      });
      const jobs = (res.data || []).slice(1);
      return jobs.map(j => ({
        id: `rok_${j.id}`,
        title: j.position || '',
        company: j.company || '',
        logo: j.company_logo || null,
        location: 'Remote',
        description: j.description || '',
        salary_raw: j.salary_max ? `$${j.salary_min || 0}k-$${j.salary_max}k` : null,
        salary_min: j.salary_min ? j.salary_min * 1000 : null,
        salary_max: j.salary_max ? j.salary_max * 1000 : null,
        url: j.url || `https://remoteok.com/l/${j.slug}`,
        apply_url: j.apply_url || j.url,
        source: 'RemoteOK',
        source_icon: '🌍',
        remote: true,
        skills: j.tags || [],
        employment_type: 'Full-time',
        posted_date: j.date ? new Date(j.date * 1000).toISOString() : new Date().toISOString(),
        views: j.views || 0,
        applications: j.applicants || 0
      }));
    } catch (e) {
      console.error('RemoteOK:', e.message);
      return [];
    }
  }

  async fetchRemotive(filters) {
    try {
      const res = await axios.get('https://remotive.com/api/remote-jobs', {
        params: { limit: 100 },
        timeout: 12000
      });
      return (res.data.jobs || []).map(j => ({
        id: `rem_${j.id}`,
        title: j.title || '',
        company: j.company_name || '',
        logo: j.company_logo || null,
        location: 'Remote',
        description: j.description || '',
        salary_raw: j.salary || null,
        salary_min: null,
        salary_max: null,
        url: j.url,
        apply_url: j.url,
        source: 'Remotive',
        source_icon: '🏠',
        remote: true,
        skills: j.tags || [],
        employment_type: j.job_type || 'Full-time',
        posted_date: j.publication_date || new Date().toISOString(),
        views: 0,
        applications: 0
      }));
    } catch (e) {
      console.error('Remotive:', e.message);
      return [];
    }
  }

  async fetchTheMuse(filters) {
    try {
      const res = await axios.get('https://www.themuse.com/api/public/jobs', {
        params: {
          page: 0,
          descending: true,
          location: 'Flexible / Remote',
          category: 'Computer and IT,Data Science,Engineering,Software Engineer'
        },
        timeout: 12000
      });
      return (res.data.results || []).map(j => ({
        id: `muse_${j.id}`,
        title: j.name || '',
        company: j.company?.name || '',
        logo: j.company?.refs?.logo_image || null,
        location: j.locations?.[0]?.name || 'Remote',
        description: j.contents || '',
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
        applications: 0
      }));
    } catch (e) {
      console.error('The Muse:', e.message);
      return [];
    }
  }

  async fetchArbeitnow(filters) {
    try {
      const res = await axios.get('https://www.arbeitnow.com/api/job-board-api', {
        timeout: 12000
      });
      return (res.data.data || [])
        .filter(j => j.remote === true || (j.location || '').toLowerCase().includes('remote'))
        .map(j => ({
          id: `arb_${j.slug}`,
          title: j.title || '',
          company: j.company_name || '',
          logo: null,
          location: j.location || 'Remote',
          description: j.description || '',
          salary_raw: null,
          salary_min: null,
          salary_max: null,
          url: j.url,
          apply_url: j.url,
          source: 'Arbeitnow',
          source_icon: '💼',
          remote: true,
          skills: j.tags || [],
          employment_type: 'Full-time',
          posted_date: j.created_at ? new Date(j.created_at * 1000).toISOString() : new Date().toISOString(),
          views: 0,
          applications: 0
        }));
    } catch (e) {
      console.error('Arbeitnow:', e.message);
      return [];
    }
  }

  async fetchFindwork(filters) {
    try {
      const res = await axios.get('https://findwork.dev/api/jobs/', {
        params: {
          remote: true,
          order_by: '-date',
          limit: 50
        },
        headers: process.env.FINDWORK_API_KEY ? {
          'Authorization': `Token ${process.env.FINDWORK_API_KEY}`
        } : {},
        timeout: 12000
      });
      return (res.data.results || []).map(j => ({
        id: `fw_${j.id}`,
        title: j.role || '',
        company: j.company_name || '',
        logo: j.company_logo || null,
        location: j.location || 'Remote',
        description: `${j.role} at ${j.company_name}. ${j.keywords?.join(', ') || ''}`,
        salary_raw: null,
        salary_min: null,
        salary_max: null,
        url: j.url,
        apply_url: j.url,
        source: 'Findwork',
        source_icon: '🔎',
        remote: j.remote || false,
        skills: j.keywords || [],
        employment_type: j.employment_type || 'Full-time',
        posted_date: j.date_posted || new Date().toISOString(),
        views: 0,
        applications: 0
      }));
    } catch (e) {
      console.error('Findwork:', e.message);
      return [];
    }
  }

  async fetchJobicy(filters) {
    try {
      const res = await axios.get('https://jobicy.com/api/v2/remote-jobs', {
        params: { count: 50 },
        timeout: 12000
      });
      return (res.data.jobs || []).map(j => ({
        id: `jobicy_${j.id}`,
        title: j.jobTitle || '',
        company: j.companyName || '',
        logo: j.companyLogo || null,
        location: 'Remote',
        description: j.jobDescription || j.jobExcerpt || '',
        salary_raw: j.jobSalary || null,
        salary_min: null,
        salary_max: null,
        url: j.url,
        apply_url: j.url,
        source: 'Jobicy',
        source_icon: '🌐',
        remote: true,
        skills: j.jobIndustry || [],
        employment_type: j.jobType || 'Full-time',
        posted_date: j.pubDate || new Date().toISOString(),
        views: 0,
        applications: 0
      }));
    } catch (e) {
      console.error('Jobicy:', e.message);
      return [];
    }
  }

  normalize(jobs) {
    const leadershipWords = ['lead', 'director', 'vp ', 'vice president', 'manager', 'principal', 'head of', 'chief', 'cto', 'ceo', 'coo', 'cfo'];
    const staffingWords = ['staffing', 'recruiting', 'recruitment', 'headhunter', 'talent solutions', 'cybercoders', 'robert half', 'manpower', 'adecco'];
    const govWords = ['federal', 'government', 'department of', 'state of ', 'county of', 'city of', 'usajobs'];

    return jobs.map(job => ({
      ...job,
      title: (job.title || '').trim(),
      company: (job.company || '').trim(),
      description: (job.description || '').replace(/<[^>]*>/g, '').trim(),
      is_leadership: leadershipWords.some(w => job.title?.toLowerCase().includes(w)),
      is_staffing: staffingWords.some(w => job.company?.toLowerCase().includes(w)),
      is_government: govWords.some(w =>
        job.company?.toLowerCase().includes(w) ||
        job.title?.toLowerCase().includes(w)
      ),
      skills: (job.skills || []).map(s => s.toLowerCase()),
      quality_score: this.calcQuality(job)
    }));
  }

  calcQuality(job) {
    let score = 50;
    if (job.description?.length > 300) score += 10;
    if (job.description?.length > 800) score += 10;
    if (job.salary_min || job.salary_raw) score += 15;
    if (job.logo) score += 5;
    if (job.skills?.length >= 3) score += 10;
    return Math.min(100, score);
  }

  // ============================================================
  // COMPLETE FILTER ENGINE - ALL FILTERS IMPLEMENTED
  // ============================================================

  applyFilters(jobs, f) {
    return jobs.filter(job => {

      // ── Remote Only ──
      if (f.remote_only !== false) {
        const loc = (job.location || '').toLowerCase();
        if (!job.remote && !loc.includes('remote')) return false;
      }

      // ── USA Only ──
      if (f.usa_only) {
        const loc = (job.location || '').toLowerCase();
        const usTerms = ['usa', 'us', 'united states', 'america', 'remote'];
        if (!usTerms.some(t => loc.includes(t))) return false;
      }

      // ── Keywords ──
      if (f.keywords && f.keywords.trim()) {
        const kw = f.keywords.toLowerCase();
        const searchable = [job.title, job.company, job.description, ...(job.skills || [])]
          .join(' ').toLowerCase();
        if (!searchable.includes(kw)) return false;
      }

      // ── Employment Type ──
      if (f.employment_type) {
        const type = (job.employment_type || '').toLowerCase();
        const map = {
          'fulltime': ['full-time', 'fulltime', 'full time'],
          'parttime': ['part-time', 'parttime', 'part time'],
          'contract': ['contract', 'freelance', 'contractor'],
          'internship': ['intern', 'internship']
        };
        const allowed = map[f.employment_type] || [f.employment_type];
        if (!allowed.some(t => type.includes(t))) return false;
      }

      // ── Experience Level ──
      if (f.experience_level) {
        const lvl = (job.experience_level || job.title || '').toLowerCase();
        const desc = (job.description || '').toLowerCase();
        const map = {
          'junior': ['junior', 'entry', 'associate', '0-2 years', '1-2 years', 'grad'],
          'mid': ['mid', 'intermediate', '2-5 years', '3-5 years', '2+ years'],
          'senior': ['senior', 'lead', 'sr.', 'sr ', '5+ years', '7+ years', 'expert']
        };
        const terms = map[f.experience_level] || [f.experience_level];
        if (!terms.some(t => lvl.includes(t) || desc.includes(t))) return false;
      }

      // ── Exclude Leadership ──
      if (f.exclude_leadership && job.is_leadership) return false;

      // ── Exclude Staffing ──
      if (f.exclude_staffing && job.is_staffing) return false;

      // ── Exclude Government ──
      if (f.exclude_government && job.is_government) return false;

      // ── Salary Range ──
      if (f.salary_min) {
        const minNum = parseInt(f.salary_min);
        if (job.salary_max && job.salary_max < minNum) return false;
        if (job.salary_min && job.salary_min < minNum) {
          if (!job.salary_max || job.salary_max < minNum) return false;
        }
      }
      if (f.salary_max) {
        const maxNum = parseInt(f.salary_max);
        if (job.salary_min && job.salary_min > maxNum) return false;
      }

      // ── Date Posted ──
      if (f.date_posted && f.date_posted !== 'all') {
        const jobDate = new Date(job.posted_date);
        const now = new Date();
        const diffHours = (now - jobDate) / 3600000;
        const maxHours = { today: 24, week: 168, month: 720 };
        const limit = maxHours[f.date_posted];
        if (limit && diffHours > limit) return false;
      }

      // ── Skills Match ──
      if (f.skills && f.skills.length > 0) {
        const jobSkills = (job.skills || []).join(' ').toLowerCase();
        const desc = (job.description || '').toLowerCase();
        const hasSkill = f.skills.some(s =>
          jobSkills.includes(s.toLowerCase()) ||
          desc.includes(s.toLowerCase())
        );
        if (!hasSkill) return false;
      }

      // ── Company Size (via description hints) ──
      if (f.company_size) {
        const desc = (job.description || '').toLowerCase();
        const sizeMap = {
          'startup': ['startup', 'start-up', 'early stage', 'seed', 'series a'],
          'mid': ['series b', 'series c', 'growing', 'mid-size', '50-200'],
          'large': ['enterprise', 'fortune 500', '1000+', 'global', 'international'],
        };
        const terms = sizeMap[f.company_size];
        if (terms && !terms.some(t => desc.includes(t))) return false;
      }

      // ── Industry ──
      if (f.industry) {
        const searchable = [job.title, job.description, ...(job.skills || [])].join(' ').toLowerCase();
        const industryMap = {
          'tech': ['software', 'tech', 'developer', 'engineer', 'programming'],
          'healthcare': ['health', 'medical', 'clinic', 'hospital', 'pharma'],
          'finance': ['finance', 'fintech', 'banking', 'investment', 'trading'],
          'aiml': ['ai', 'machine learning', 'ml', 'deep learning', 'nlp', 'data science'],
          'cybersecurity': ['security', 'cyber', 'infosec', 'devsecops', 'soc'],
          'saas': ['saas', 'b2b', 'platform', 'cloud', 'subscription']
        };
        const terms = industryMap[f.industry] || [f.industry];
        if (!terms.some(t => searchable.includes(t))) return false;
      }

      // ── Easy Apply (has direct apply URL) ──
      if (f.easy_apply) {
        if (!job.apply_url || job.apply_url === job.url) return false;
      }

      // ── Visa Sponsorship ──
      if (f.visa_sponsorship) {
        const desc = (job.description || '').toLowerCase();
        const visaTerms = ['visa', 'sponsorship', 'sponsor', 'authorized to work', 'h1b'];
        if (!visaTerms.some(t => desc.includes(t))) return false;
      }

      // ── Exclude certain keywords ──
      if (f.exclude_keywords && f.exclude_keywords.length > 0) {
        const title = (job.title || '').toLowerCase();
        if (f.exclude_keywords.some(kw => title.includes(kw.toLowerCase()))) return false;
      }

      // ── Fast Growing Companies ──
      if (f.fast_growing) {
        const desc = (job.description || '').toLowerCase();
        const growthTerms = ['fast-growing', 'hypergrowth', 'series', 'yc', 'y combinator', 'rapidly growing', 'scaling'];
        if (!growthTerms.some(t => desc.includes(t))) return false;
      }

      return true;
    });
  }

  deduplicate(jobs) {
    const seen = new Set();
    return jobs.filter(job => {
      if (!job.title || !job.company) return false;
      const key = `${job.title.toLowerCase().slice(0, 25)}_${job.company.toLowerCase().slice(0, 15)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  scoreJobs(jobs, filters) {
    return jobs.map(job => {
      let score = job.quality_score || 50;
      const kw = (filters.keywords || '').toLowerCase();
      if (kw && job.title?.toLowerCase().includes(kw)) score += 25;
      const desc = (job.description || '').toLowerCase();
      if (kw && desc.includes(kw)) score += 10;
      const daysOld = (Date.now() - new Date(job.posted_date)) / 86400000;
      if (daysOld < 1) score += 15;
      else if (daysOld < 3) score += 10;
      else if (daysOld < 7) score += 5;
      if (job.salary_min || job.salary_raw) score += 10;
      return { ...job, match_score: Math.min(100, score) };
    });
  }

  sort(jobs, by) {
    const sorted = [...jobs];
    const sorters = {
      date: (a, b) => new Date(b.posted_date) - new Date(a.posted_date),
      salary: (a, b) => (b.salary_max || b.salary_min || 0) - (a.salary_max || a.salary_min || 0),
      match: (a, b) => b.match_score - a.match_score,
      company: (a, b) => a.company.localeCompare(b.company),
      title: (a, b) => a.title.localeCompare(b.title)
    };
    return sorted.sort(sorters[by] || sorters.date);
  }
}

const jobAggregator = new JobAggregator();

// ============================================================
// AI ENGINE - GEMINI + GROQ + HUGGINGFACE + LOCAL FALLBACK
// ============================================================

class AIEngine {

  async chat(messages, context = '') {
    // Try providers in order
    const providers = [
      () => this.gemini(messages, context),
      () => this.groq(messages, context),
      () => this.huggingface(messages),
      () => this.localFallback(messages)
    ];

    for (const provider of providers) {
      try {
        const result = await provider();
        if (result) return result;
      } catch (e) {
        console.error('AI provider failed:', e.message);
      }
    }

    return { message: 'I\'m having trouble connecting. Please try again.', provider: 'error' };
  }

  async gemini(messages, context) {
    if (!process.env.GEMINI_API_KEY) return null;

    const systemPrompt = `You are an expert AI career assistant for RemoteHunt 2026. 
You help with: remote job searching, resume optimization, interview preparation, salary negotiation, and career planning.
Be concise, actionable, and encouraging. Use emojis occasionally.
${context ? `Context: ${context}` : ''}`;

    const formattedMessages = messages.length === 1
      ? [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUser: ${messages[0].content}` }] }]
      : messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));

    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: formattedMessages,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
      },
      { timeout: 20000 }
    );

    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? { message: text, provider: 'Google Gemini' } : null;
  }

  async groq(messages, context) {
    if (!process.env.GROQ_API_KEY) return null;

    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama3-8b-8192',
        messages: [
          {
            role: 'system',
            content: `You are an expert AI career assistant. Help with job searching, resumes, interviews, and salary negotiation. Be concise and actionable. ${context}`
          },
          ...messages
        ],
        max_tokens: 1024,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const text = res.data?.choices?.[0]?.message?.content;
    return text ? { message: text, provider: 'Groq (Llama 3)' } : null;
  }

  async huggingface(messages) {
    if (!process.env.HF_API_TOKEN) return null;

    const lastMessage = messages[messages.length - 1]?.content || '';
    const prompt = `You are a career assistant. Answer this: ${lastMessage}\n\nAnswer:`;

    const res = await axios.post(
      'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.1',
      {
        inputs: prompt,
        parameters: { max_new_tokens: 512, return_full_text: false }
      },
      {
        headers: { 'Authorization': `Bearer ${process.env.HF_API_TOKEN}` },
        timeout: 30000
      }
    );

    const text = res.data?.[0]?.generated_text;
    return text ? { message: text.trim(), provider: 'Hugging Face' } : null;
  }

  localFallback(messages) {
    const msg = (messages[messages.length - 1]?.content || '').toLowerCase();

    const knowledge = {
      resume: `📄 **Resume Tips for 2026:**\n\n✅ **ATS Optimization**\n- Use exact keywords from job description\n- Standard fonts (Arial, Calibri)\n- No tables, columns, or images\n\n✅ **Content**\n- Quantify everything: "Increased sales by 40%"\n- Lead with strong summary (3 lines)\n- Skills section matching job requirements\n\n✅ **Remote-Specific**\n- Mention remote tools: Slack, Zoom, Jira, Notion\n- Show self-management and async communication\n- List home office setup if relevant\n\n✅ **Format**\n- 1 page (junior), 2 pages max (senior)\n- Reverse chronological order\n- PDF format always`,

      interview: `🎤 **Remote Interview Mastery:**\n\n**Before:**\n- Test camera, mic, internet 30min early\n- Professional background (virtual or real)\n- Research company deeply\n- Prepare STAR method stories\n\n**During:**\n- Look at camera, not screen\n- Pause before answering\n- Keep water nearby\n- Take notes openly\n\n**Common Questions:**\n- "How do you stay productive remotely?"\n- "How do you handle timezone differences?"\n- "Describe your home office setup"\n\n**Questions to Ask:**\n- "How does the team communicate daily?"\n- "What does success look like in 90 days?"\n- "What's the biggest challenge for this role?"`,

      salary: `💰 **Salary Negotiation 2026:**\n\n**Research First:**\n- Glassdoor, Levels.fyi, Payscale, LinkedIn Salary\n- Ask people in similar roles\n- Check remote vs local pay differences\n\n**Strategy:**\n- Never give first number\n- Always negotiate (73% of employers expect it)\n- Ask for time: "Can I have 24 hours to review?"\n- Negotiate total comp: salary + equity + PTO + WFH stipend\n\n**Scripts:**\n- "Based on my research, I was expecting $X-$Y"\n- "Is there flexibility on the base salary?"\n- "What's the range budgeted for this role?"\n\n**Remote Consideration:**\n- Some companies pay based on location\n- Use cost of living data to argue your case`,

      apply: `🚀 **Job Application Strategy:**\n\n**Quality over Quantity:**\n- Apply to 5-10 targeted jobs vs 100 random\n- Customize each application (takes 20min)\n- Track everything in a spreadsheet\n\n**Application Checklist:**\n✅ Tailored resume (match job keywords)\n✅ Custom cover letter (3 paragraphs)\n✅ Research company (know their product)\n✅ LinkedIn profile updated\n✅ Follow up in 5-7 days\n\n**Remote Job Boards:**\n- RemoteOK, Remotive, We Work Remotely\n- AngelList (startups), Greenhouse\n- Company career pages directly`,

      skills: `🎯 **Most In-Demand Skills 2026:**\n\n**Tech:**\n- AI/ML: Python, TensorFlow, LangChain\n- Cloud: AWS, Azure, GCP\n- Web: React, TypeScript, Node.js\n- DevOps: Docker, Kubernetes, CI/CD\n\n**Non-Tech:**\n- AI Prompt Engineering\n- Data Analysis (SQL, Python)\n- Project Management (PMP, Agile)\n- Cybersecurity Basics\n\n**Free Learning:**\n- freeCodeCamp (web dev)\n- fast.ai (machine learning)\n- Google Cloud Free Tier\n- Coursera (audit for free)`,

      default: `👋 **Hi! I'm your AI Career Assistant!**\n\nI can help you with:\n\n📄 **Resume** - ATS optimization, formatting, keywords\n🎤 **Interviews** - Prep, questions, remote tips\n💰 **Salary** - Negotiation scripts, market rates\n🚀 **Applications** - Strategy, cover letters, follow-ups\n🎯 **Skills** - What to learn, free resources\n🏠 **Remote Work** - Best practices, tools, productivity\n\nWhat would you like help with?`
    };

    let response = knowledge.default;
    if (msg.includes('resume') || msg.includes('cv') || msg.includes('ats')) response = knowledge.resume;
    else if (msg.includes('interview') || msg.includes('question')) response = knowledge.interview;
    else if (msg.includes('salary') || msg.includes('pay') || msg.includes('negotiat') || msg.includes('compensation')) response = knowledge.salary;
    else if (msg.includes('apply') || msg.includes('application') || msg.includes('cover letter')) response = knowledge.apply;
    else if (msg.includes('skill') || msg.includes('learn') || msg.includes('course')) response = knowledge.skills;

    return { message: response, provider: 'RemoteHunt AI' };
  }

  async analyzeResume(resumeText, jobDescription) {
    // Smart skill extraction
    const techSkills = [
      'javascript', 'typescript', 'python', 'java', 'c#', 'c++', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin',
      'react', 'angular', 'vue', 'nextjs', 'nodejs', 'express', 'django', 'flask', 'spring', 'laravel',
      'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb',
      'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'jenkins', 'github actions',
      'git', 'graphql', 'rest', 'grpc', 'microservices', 'kafka', 'rabbitmq',
      'machine learning', 'deep learning', 'tensorflow', 'pytorch', 'scikit-learn', 'pandas', 'numpy',
      'html', 'css', 'tailwind', 'sass', 'figma', 'sketch',
      'agile', 'scrum', 'kanban', 'jira', 'confluence', 'notion',
      'linux', 'bash', 'ci/cd', 'devops', 'sre', 'datadog', 'grafana'
    ];

    const softSkills = [
      'communication', 'leadership', 'teamwork', 'problem-solving', 'critical thinking',
      'time management', 'adaptability', 'creativity', 'mentoring', 'collaboration'
    ];

    const resumeLower = resumeText.toLowerCase();
    const jobLower = jobDescription.toLowerCase();

    const resumeTechSkills = techSkills.filter(s => resumeLower.includes(s));
    const jobTechSkills = techSkills.filter(s => jobLower.includes(s));
    const resumeSoftSkills = softSkills.filter(s => resumeLower.includes(s));
    const jobSoftSkills = softSkills.filter(s => jobLower.includes(s));

    const matchingTech = jobTechSkills.filter(s => resumeTechSkills.includes(s));
    const missingTech = jobTechSkills.filter(s => !resumeTechSkills.includes(s));
    const matchingSoft = jobSoftSkills.filter(s => resumeSoftSkills.includes(s));
    const missingSoft = jobSoftSkills.filter(s => !resumeSoftSkills.includes(s));

    // Calculate scores
    const techScore = jobTechSkills.length > 0
      ? Math.round((matchingTech.length / jobTechSkills.length) * 100)
      : 70;

    const softScore = jobSoftSkills.length > 0
      ? Math.round((matchingSoft.length / jobSoftSkills.length) * 100)
      : 70;

    // ATS score
    const atsChecks = {
      hasContactInfo: /email|phone|\d{3}[-.]?\d{3}[-.]?\d{4}/i.test(resumeText),
      hasExperience: /experience|work history|employment/i.test(resumeText),
      hasEducation: /education|degree|university|college|bachelor|master/i.test(resumeText),
      hasSkills: /skills|technologies|tools|competencies/i.test(resumeText),
      hasBullets: /•|-|\*/m.test(resumeText),
      hasQuantification: /\d+%|\$\d+|\d+ [a-z]+ (team|people|users|clients)/i.test(resumeText),
      noImages: true,
      goodLength: resumeText.length > 500 && resumeText.length < 5000
    };
    const atsScore = Math.round(
      (Object.values(atsChecks).filter(Boolean).length / Object.keys(atsChecks).length) * 100
    );

    const matchScore = Math.round((techScore * 0.5) + (softScore * 0.2) + (atsScore * 0.3));

    // Experience gap analysis
    const experienceGaps = [];
    if (!atsChecks.hasQuantification) {
      experienceGaps.push('Add quantifiable achievements (%, $, numbers)');
    }
    if (missingTech.length > 3) {
      experienceGaps.push(`Major skill gaps: ${missingTech.slice(0, 3).join(', ')}`);
    }
    if (!atsChecks.hasSkills) {
      experienceGaps.push('Add a dedicated Skills section');
    }

    // Improvements
    const improvements = [];
    if (!atsChecks.hasQuantification) improvements.push('Quantify your achievements with numbers and percentages');
    if (missingTech.length > 0) improvements.push(`Learn or add: ${missingTech.slice(0, 5).join(', ')}`);
    if (!resumeLower.includes('remote')) improvements.push('Mention your remote work experience and tools');
    if (!atsChecks.hasBullets) improvements.push('Use bullet points for better readability');
    if (resumeText.split(' ').length < 300) improvements.push('Expand your resume - it seems too short');

    // Get AI-enhanced analysis
    let aiAnalysis = null;
    try {
      const prompt = `Analyze this resume vs job description match in 3 sentences. Be specific about the biggest opportunity.
Resume skills: ${resumeTechSkills.join(', ')}
Job requires: ${jobTechSkills.join(', ')}
Match: ${matchScore}%`;

      const aiResult = await this.chat([{ role: 'user', content: prompt }]);
      aiAnalysis = aiResult?.message;
    } catch (e) {
      console.error('AI analysis failed:', e.message);
    }

    return {
      matchScore,
      techScore,
      softScore,
      atsScore,
      matchingSkills: [...matchingTech, ...matchingSoft],
      missingSkills: [...missingTech, ...missingSoft],
      extraSkills: resumeTechSkills.filter(s => !jobTechSkills.includes(s)),
      atsChecks,
      experienceGaps,
      improvements,
      aiAnalysis,
      keywordsToAdd: missingTech.slice(0, 8)
    };
  }
}

const aiEngine = new AIEngine();

// ============================================================
// API ROUTES - ALL ENDPOINTS
// ============================================================

// ── Auth Routes ──

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }

    if (Database.findUserByEmail(email)) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = Database.createUser({
      name,
      email: email.toLowerCase(),
      password: hash,
      preferences: {
        remote_only: true,
        usa_only: false,
        employment_type: 'fulltime',
        experience_level: '',
        exclude_leadership: true,
        exclude_staffing: true,
        salary_min: null,
        preferred_skills: [],
        saved_titles: [],
        saved_companies: []
      }
    });

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'remotehunt_secret_2026',
      { expiresIn: '30d' }
    );

    const { password: _, ...userSafe } = user;

    res.json({ success: true, token, user: userSafe });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = Database.findUserByEmail(email?.toLowerCase());
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'remotehunt_secret_2026',
      { expiresIn: '30d' }
    );

    const { password: _, ...userSafe } = user;
    res.json({ success: true, token, user: userSafe });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  const { password, ...userSafe } = req.user;
  res.json({ success: true, user: userSafe });
});

app.put('/api/auth/preferences', auth, (req, res) => {
  try {
    const updated = Database.updateUser(req.user.id, {
      preferences: { ...req.user.preferences, ...req.body }
    });
    res.json({ success: true, preferences: updated.preferences });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Job Routes ──

app.get('/api/jobs/search', optionalAuth, async (req, res) => {
  try {
    const userPrefs = req.user?.preferences || {};

    const filters = {
      keywords: req.query.keywords || req.query.q || '',
      remote_only: req.query.remote_only !== 'false',
      usa_only: req.query.usa_only === 'true',
      employment_type: req.query.employment_type || userPrefs.employment_type || '',
      experience_level: req.query.experience_level || userPrefs.experience_level || '',
      exclude_leadership: req.query.exclude_leadership !== 'false',
      exclude_staffing: req.query.exclude_staffing !== 'false',
      exclude_government: req.query.exclude_government === 'true',
      salary_min: req.query.salary_min ? parseInt(req.query.salary_min) : (userPrefs.salary_min || null),
      salary_max: req.query.salary_max ? parseInt(req.query.salary_max) : null,
      date_posted: req.query.date_posted || 'week',
      skills: req.query.skills ? req.query.skills.split(',').map(s => s.trim()) : [],
      industry: req.query.industry || '',
      company_size: req.query.company_size || '',
      visa_sponsorship: req.query.visa_sponsorship === 'true' ? true : null,
      easy_apply: req.query.easy_apply === 'true',
      fast_growing: req.query.fast_growing === 'true',
      exclude_keywords: req.query.exclude_keywords ? req.query.exclude_keywords.split(',') : [],
      sort: req.query.sort || 'date',
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20
    };

    const result = await jobAggregator.fetchAllJobs(filters);

    // Paginate
    const start = (filters.page - 1) * filters.limit;
    const paginated = result.jobs.slice(start, start + filters.limit);

    res.json({
      success: true,
      jobs: paginated,
      total: result.jobs.length,
      page: filters.page,
      totalPages: Math.ceil(result.jobs.length / filters.limit),
      hasMore: start + filters.limit < result.jobs.length,
      sources: result.sources,
      filters
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/jobs/save', auth, (req, res) => {
  try {
    const { job } = req.body;
    const saved = Database.saveJob({ userId: req.user.id, jobId: job.id, job });

    if (!saved) {
      return res.json({ success: true, message: 'Already saved' });
    }

    Database.addNotification(req.user.id, {
      type: 'job_saved',
      title: 'Job Saved',
      message: `${job.title} at ${job.company} saved successfully`
    });

    res.json({ success: true, saved });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/jobs/save/:jobId', auth, (req, res) => {
  Database.unsaveJob(req.user.id, req.params.jobId);
  res.json({ success: true });
});

app.get('/api/jobs/saved', auth, (req, res) => {
  const saved = Database.getSavedJobs(req.user.id);
  res.json({ success: true, jobs: saved.map(s => s.job), total: saved.length });
});

// ── Resume Routes ──

app.post('/api/resume/analyze', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body;

    if (!resumeText || !jobDescription) {
      return res.status(400).json({ success: false, error: 'Both resume and job description required' });
    }

    const analysis = await aiEngine.analyzeResume(resumeText, jobDescription);
    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/resume/save', auth, (req, res) => {
  try {
    const { title, content } = req.body;
    const resume = Database.saveResume({ userId: req.user.id, title, content });
    res.json({ success: true, resume });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/resume/list', auth, (req, res) => {
  const resumes = Database.getUserResumes(req.user.id);
  res.json({ success: true, resumes });
});

// ── Application Routes ──

app.post('/api/applications', auth, (req, res) => {
  try {
    const { job, status, notes } = req.body;
    const application = Database.addApplication({
      userId: req.user.id,
      jobId: job.id,
      job,
      status: status || 'applied',
      notes,
      timeline: [{ status: 'applied', date: new Date().toISOString() }]
    });

    Database.addNotification(req.user.id, {
      type: 'application',
      title: 'Application Tracked',
      message: `${job.title} at ${job.company} added to tracker`
    });

    res.json({ success: true, application });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/applications', auth, (req, res) => {
  const applications = Database.getUserApplications(req.user.id);
  res.json({ success: true, applications, total: applications.length });
});

app.put('/api/applications/:id', auth, (req, res) => {
  try {
    const { status, notes, interviewDate } = req.body;
    const app = Database.applications.get(req.params.id);

    if (!app || app.userId !== req.user.id) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    const timeline = [...(app.timeline || []), {
      status,
      date: new Date().toISOString(),
      notes
    }];

    const updated = Database.updateApplication(req.params.id, {
      status,
      notes,
      interviewDate,
      timeline
    });

    res.json({ success: true, application: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── AI Chat Routes ──

app.post('/api/chat', optionalAuth, async (req, res) => {
  try {
    const { message, conversationId, context } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message required' });
    }

    // Get conversation history
    const convId = conversationId || uuidv4();
    const history = cache.get(`chat_${convId}`) || [];

    history.push({ role: 'user', content: message });

    const response = await aiEngine.chat(history.slice(-8), context);

    history.push({ role: 'assistant', content: response.message });
    cache.set(`chat_${convId}`, history, 3600);

    res.json({
      success: true,
      conversationId: convId,
      response
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Analytics Routes ──

app.get('/api/analytics', auth, (req, res) => {
  const applications = Database.getUserApplications(req.user.id);
  const savedJobs = Database.getSavedJobs(req.user.id);

  const statusCounts = applications.reduce((acc, app) => {
    acc[app.status] = (acc[app.status] || 0) + 1;
    return acc;
  }, {});

  const recentActivity = applications
    .slice(0, 5)
    .map(a => ({ ...a, type: 'application' }));

  res.json({
    success: true,
    analytics: {
      totalApplications: applications.length,
      savedJobs: savedJobs.length,
      statusBreakdown: statusCounts,
      responseRate: applications.length > 0
        ? Math.round(((statusCounts.interviewing || 0) + (statusCounts.offered || 0)) / applications.length * 100)
        : 0,
      recentActivity
    }
  });
});

// ── Notification Routes ──

app.get('/api/notifications', auth, (req, res) => {
  const notifications = Database.getNotifications(req.user.id);
  res.json({ success: true, notifications, unread: notifications.filter(n => !n.read).length });
});

app.put('/api/notifications/:id/read', auth, (req, res) => {
  Database.markRead(req.user.id, req.params.id);
  res.json({ success: true });
});

// ── Health ──

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    features: {
      jobSearch: true,
      aiChat: !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.HF_API_TOKEN),
      resumeAnalysis: true,
      applicationTracker: true,
      aiProvider: process.env.GEMINI_API_KEY ? 'Gemini' : process.env.GROQ_API_KEY ? 'Groq' : 'Local'
    }
  });
});

// ── Frontend ──

app.get('/', (req, res) => res.send(FRONTEND));
app.get('*', (req, res) => res.send(FRONTEND));

// ============================================================
// COMPLETE FRONTEND - EMBEDDED
// ============================================================

const FRONTEND = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RemoteHunt 2026 - AI Job Search</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
--p:#6366f1;--p2:#4f46e5;--s:#06b6d4;--g:#10b981;--w:#f59e0b;--d:#ef4444;
--bg:#f1f5f9;--card:#fff;--text:#0f172a;--sub:#64748b;--border:#e2e8f0;
--radius:12px;--shadow:0 4px 16px rgba(0,0,0,.08)
}
[data-theme=dark]{
--bg:#0f172a;--card:#1e293b;--text:#f1f5f9;--sub:#94a3b8;--border:#334155
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);transition:background .3s}
a{text-decoration:none;color:inherit}
button{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit}

/* NAV */
nav{position:sticky;top:0;z-index:100;background:var(--card);border-bottom:1px solid var(--border);padding:0 20px;height:64px;display:flex;align-items:center;justify-content:space-between;box-shadow:var(--shadow)}
.logo{font-size:22px;font-weight:800;background:linear-gradient(135deg,var(--p),var(--s));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-tabs{display:flex;gap:4px;background:var(--bg);padding:4px;border-radius:10px}
.nav-tab{padding:8px 16px;border:none;background:transparent;color:var(--sub);font-size:14px;font-weight:500;border-radius:8px;transition:all .2s}
.nav-tab.active{background:var(--card);color:var(--p);box-shadow:var(--shadow)}
.nav-right{display:flex;gap:8px;align-items:center}
.icon-btn{width:38px;height:38px;border:1px solid var(--border);background:var(--card);color:var(--sub);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;transition:all .2s}
.icon-btn:hover{background:var(--p);color:#fff;border-color:var(--p)}
.badge{background:var(--d);color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;display:flex;align-items:center;justify-content:center;position:absolute;top:-4px;right:-4px}

/* LAYOUT */
.app{display:flex;flex:1;min-height:calc(100vh - 64px)}
.page{display:none;flex:1;padding:24px;max-width:1400px;margin:0 auto;width:100%}
.page.active{display:block}

/* SEARCH HERO */
.hero{text-align:center;padding:40px 0 32px}
.hero h1{font-size:40px;font-weight:800;line-height:1.2;margin-bottom:10px}
.gradient{background:linear-gradient(135deg,var(--p),var(--s));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{color:var(--sub);font-size:17px;margin-bottom:28px}
.search-wrap{max-width:700px;margin:0 auto}
.search-bar{display:flex;gap:10px;background:var(--card);padding:8px;border-radius:16px;box-shadow:0 8px 32px rgba(99,102,241,.15);border:2px solid transparent;transition:.3s}
.search-bar:focus-within{border-color:var(--p)}
.search-bar input{flex:1;border:none;outline:none;font-size:16px;background:transparent;color:var(--text);padding:8px}
.btn{padding:12px 28px;border:none;border-radius:10px;font-weight:600;font-size:14px;transition:all .2s;display:inline-flex;align-items:center;gap:8px}
.btn-primary{background:linear-gradient(135deg,var(--p),var(--p2));color:#fff}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(99,102,241,.4)}
.btn-sm{padding:7px 16px;font-size:13px}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{border-color:var(--p);color:var(--p)}
.btn-danger{background:var(--d);color:#fff}
.btn-success{background:var(--g);color:#fff}

/* QUICK TAGS */
.quick-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;justify-content:center}
.quick-tag{padding:6px 16px;background:var(--card);border:1px solid var(--border);border-radius:20px;font-size:13px;color:var(--sub);cursor:pointer;transition:.2s}
.quick-tag:hover{background:var(--p);color:#fff;border-color:var(--p)}

/* FILTERS PANEL */
.filter-wrap{background:var(--card);border-radius:var(--radius);padding:20px;margin-bottom:24px;border:1px solid var(--border)}
.filter-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.f-group{display:flex;flex-direction:column;gap:5px}
.f-label{font-size:12px;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.5px}
.f-select,.f-input{padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;outline:none;transition:.2s}
.f-select:focus,.f-input:focus{border-color:var(--p)}
.checks-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.check-item{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.check-item input[type=checkbox]{width:16px;height:16px;accent-color:var(--p)}
.salary-row{display:flex;gap:10px;margin-top:12px}
.salary-row input{flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;outline:none}

/* SMART FILTERS */
.smart-filters{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.smart-btn{padding:7px 16px;border:2px solid var(--border);background:transparent;border-radius:20px;font-size:13px;font-weight:500;color:var(--sub);transition:.2s}
.smart-btn:hover,.smart-btn.active{border-color:var(--p);background:var(--p);color:#fff}

/* STATS */
.stats-bar{background:linear-gradient(135deg,var(--p),var(--s));color:#fff;padding:16px 20px;border-radius:var(--radius);margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.stat-num{font-size:28px;font-weight:800}
.source-tags{display:flex;gap:6px;flex-wrap:wrap}
.src-tag{padding:4px 10px;background:rgba(255,255,255,.2);border-radius:20px;font-size:12px}

/* JOB CARDS */
.job-list{display:grid;gap:16px}
.job-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px;cursor:pointer;transition:all .25s;position:relative;overflow:hidden}
.job-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,var(--p),var(--s));opacity:0;transition:.3s}
.job-card:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--p)}
.job-card:hover::before{opacity:1}
.jc-top{display:flex;gap:14px;align-items:flex-start}
.company-logo{width:48px;height:48px;border-radius:10px;object-fit:contain;background:var(--bg);border:1px solid var(--border);padding:4px;flex-shrink:0}
.logo-placeholder{width:48px;height:48px;border-radius:10px;background:linear-gradient(135deg,var(--p),var(--s));color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0}
.jc-info{flex:1;min-width:0}
.jc-title{font-size:18px;font-weight:700;margin-bottom:3px;line-height:1.3}
.jc-company{color:var(--sub);font-size:14px;font-weight:500}
.jc-score{font-size:12px;font-weight:700;padding:4px 10px;border-radius:20px;background:linear-gradient(135deg,var(--p),var(--s));color:#fff}
.jc-meta{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0;font-size:13px;color:var(--sub)}
.jc-meta span{display:flex;align-items:center;gap:4px}
.pill{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.pill-remote{background:#d1fae5;color:#065f46}
.pill-salary{background:#dbeafe;color:#1e40af}
.pill-new{background:#fef3c7;color:#92400e}
.pill-type{background:#f3e8ff;color:#6b21a8}
.jc-desc{font-size:13px;color:var(--sub);line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:10px 0}
.skill-tags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.skill-tag{padding:3px 10px;background:var(--bg);border:1px solid var(--border);border-radius:20px;font-size:12px;color:var(--sub)}
.jc-footer{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
.jc-source{font-size:12px;color:var(--sub)}
.jc-actions{display:flex;gap:8px}
.save-btn{width:36px;height:36px;border:1px solid var(--border);background:transparent;border-radius:8px;font-size:18px;display:flex;align-items:center;justify-content:center;transition:.2s}
.save-btn:hover,.save-btn.saved{background:var(--w);border-color:var(--w);color:#fff}

/* LOADING */
.loading{text-align:center;padding:60px 20px}
.spinner{width:48px;height:48px;border:4px solid var(--border);border-top-color:var(--p);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
.dots{display:flex;gap:8px;justify-content:center;margin-bottom:16px}
.dot{width:12px;height:12px;background:var(--p);border-radius:50%;animation:bounce 1.4s ease-in-out infinite}
.dot:nth-child(2){animation-delay:.2s}
.dot:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,80%,100%{transform:scale(0);opacity:.5}40%{transform:scale(1);opacity:1}}
.empty{text-align:center;padding:60px 20px;color:var(--sub)}
.empty-icon{font-size:48px;margin-bottom:16px}

/* RESUME PAGE */
.page-header{text-align:center;margin-bottom:32px}
.page-header h1{font-size:32px;font-weight:800;margin-bottom:8px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px}
.card h3{font-size:16px;font-weight:700;margin-bottom:16px}
textarea{width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical;outline:none;font-size:14px;line-height:1.6;transition:.2s}
textarea:focus{border-color:var(--p)}
.score-ring{position:relative;width:140px;height:140px;margin:0 auto 20px}
.score-ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.score-text{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
.score-num{font-size:36px;font-weight:800}
.score-lbl{font-size:12px;color:var(--sub)}
.pills-wrap{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.match-pill{padding:5px 12px;border-radius:20px;font-size:13px;font-weight:500}
.found{background:#d1fae5;color:#065f46}
.missing{background:#fee2e2;color:#991b1b}
.extra{background:#dbeafe;color:#1e40af}
.tip-list li{font-size:14px;color:var(--sub);padding:6px 0;border-bottom:1px solid var(--border);list-style:none;display:flex;gap:8px}
.progress-bar{height:8px;background:var(--bg);border-radius:4px;margin-top:6px;overflow:hidden}
.progress-fill{height:100%;border-radius:4px;transition:width 1s ease}

/* APPLICATIONS */
.kanban{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.kanban-col{background:var(--bg);border-radius:var(--radius);padding:16px}
.kanban-title{font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px;font-size:14px}
.app-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px}
.app-card h4{font-size:14px;font-weight:600;margin-bottom:4px}
.app-card p{font-size:12px;color:var(--sub)}
.app-date{font-size:11px;color:var(--sub);margin-top:6px}

/* AI CHAT */
.chat-fab{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,var(--p),var(--s));color:#fff;border:none;font-size:24px;box-shadow:0 4px 20px rgba(99,102,241,.4);z-index:200;transition:.3s}
.chat-fab:hover{transform:scale(1.1)}
.chat-panel{position:fixed;right:20px;bottom:90px;width:360px;height:520px;background:var(--card);border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.15);display:none;flex-direction:column;z-index:200;overflow:hidden;border:1px solid var(--border)}
.chat-panel.open{display:flex}
.chat-head{background:linear-gradient(135deg,var(--p),var(--s));color:#fff;padding:16px;display:flex;justify-content:space-between;align-items:center}
.chat-head h3{font-size:15px;font-weight:700}
.chat-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:85%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.6}
.msg.bot{background:var(--bg);align-self:flex-start;border-bottom-left-radius:4px}
.msg.user{background:var(--p);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.chat-suggestions{padding:0 16px 12px;display:flex;flex-wrap:wrap;gap:6px}
.chat-sugg{padding:6px 12px;border:1px solid var(--border);background:transparent;border-radius:20px;font-size:12px;color:var(--sub);cursor:pointer;transition:.2s}
.chat-sugg:hover{border-color:var(--p);color:var(--p)}
.chat-foot{padding:12px;border-top:1px solid var(--border);display:flex;gap:8px}
.chat-foot input{flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);outline:none;font-size:14px}
.chat-foot input:focus{border-color:var(--p)}
.send-btn{width:38px;height:38px;background:var(--p);color:#fff;border:none;border-radius:10px;font-size:18px;display:flex;align-items:center;justify-content:center}
.provider-tag{font-size:11px;color:var(--sub);padding:4px 12px}
.typing span{display:inline-block;width:8px;height:8px;background:var(--sub);border-radius:50%;animation:bounce 1.4s ease-in-out infinite;margin:0 2px}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}

/* MODAL */
.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:300;align-items:center;justify-content:center;padding:20px}
.modal-backdrop.open{display:flex}
.modal{background:var(--card);border-radius:20px;max-width:800px;width:100%;max-height:85vh;overflow-y:auto;padding:32px;position:relative;animation:modalIn .3s ease}
@keyframes modalIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.modal-close{position:absolute;top:16px;right:16px;width:36px;height:36px;border:none;background:var(--bg);border-radius:50%;font-size:18px;color:var(--sub);transition:.2s}
.modal-close:hover{background:var(--d);color:#fff}

/* AUTH */
.auth-wrap{max-width:400px;margin:60px auto}
.auth-form input{width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:15px;outline:none;margin-bottom:12px;transition:.2s}
.auth-form input:focus{border-color:var(--p)}
.auth-toggle{text-align:center;margin-top:16px;font-size:14px;color:var(--sub)}
.auth-toggle a{color:var(--p);font-weight:600;cursor:pointer}

/* TOAST */
.toast-wrap{position:fixed;bottom:24px;left:24px;z-index:400;display:flex;flex-direction:column;gap:8px}
.toast{padding:12px 20px;border-radius:10px;background:var(--card);border:1px solid var(--border);box-shadow:var(--shadow);font-size:14px;display:flex;align-items:center;gap:10px;animation:slideUp .3s ease;max-width:320px}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}}
.toast.success{border-left:4px solid var(--g)}
.toast.error{border-left:4px solid var(--d)}
.toast.info{border-left:4px solid var(--p)}

/* DASHBOARD */
.dash-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.dash-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.dash-num{font-size:36px;font-weight:800;background:linear-gradient(135deg,var(--p),var(--s));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.dash-label{font-size:14px;color:var(--sub);margin-top:4px}

/* RESPONSIVE */
@media(max-width:768px){
  .nav-tabs .nav-tab span{display:none}
  .hero h1{font-size:28px}
  .two-col{grid-template-columns:1fr}
  .filter-grid{grid-template-columns:1fr 1fr}
  .chat-panel{width:calc(100vw - 20px);right:10px}
  .page{padding:16px}
  .modal{padding:20px}
}
@media(max-width:480px){
  .filter-grid{grid-template-columns:1fr}
  .jc-actions{flex-direction:column}
}
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="logo">🏠 RemoteHunt</div>
  <div class="nav-tabs">
    <button class="nav-tab active" onclick="show('search',this)">🔍 <span>Jobs</span></button>
    <button class="nav-tab" onclick="show('resume',this)">📄 <span>Resume</span></button>
    <button class="nav-tab" onclick="show('applications',this)">📋 <span>Tracker</span></button>
    <button class="nav-tab" onclick="show('dashboard',this)">📊 <span>Dashboard</span></button>
  </div>
  <div class="nav-right">
    <button class="icon-btn" onclick="toggleTheme()" title="Theme">🌙</button>
    <div style="position:relative">
      <button class="icon-btn" onclick="show('auth',this)" id="authBtn" title="Account">👤</button>
    </div>
  </div>
</nav>

<div class="app">

<!-- ══════════════ JOB SEARCH PAGE ══════════════ -->
<div id="page-search" class="page active">

  <div class="hero">
    <h1>Find Your <span class="gradient">Perfect Remote Job</span></h1>
    <p>AI-powered search across 6+ live job platforms</p>
    <div class="search-wrap">
      <div class="search-bar">
        <span style="font-size:20px;padding:0 4px">🔍</span>
        <input id="kw" placeholder="Job title, skills, company..." value="software developer"
          onkeydown="if(event.key==='Enter')doSearch()">
        <button class="btn btn-primary" onclick="doSearch()" id="searchBtn">Search</button>
      </div>
      <div class="quick-tags">
        <span class="quick-tag" onclick="qs('react developer')">⚛️ React</span>
        <span class="quick-tag" onclick="qs('python developer')">🐍 Python</span>
        <span class="quick-tag" onclick="qs('data analyst')">📊 Data Analyst</span>
        <span class="quick-tag" onclick="qs('product manager')">🎯 Product Manager</span>
        <span class="quick-tag" onclick="qs('ui ux designer')">🎨 UI/UX</span>
        <span class="quick-tag" onclick="qs('devops engineer')">⚙️ DevOps</span>
        <span class="quick-tag" onclick="qs('machine learning')">🤖 ML Engineer</span>
        <span class="quick-tag" onclick="qs('cybersecurity')">🔒 Security</span>
      </div>
    </div>
  </div>

  <!-- FILTERS -->
  <div class="filter-wrap">
    <div class="filter-header">
      <strong>🎯 Advanced Filters</strong>
      <button class="btn btn-outline btn-sm" onclick="resetFilters()">Reset</button>
    </div>

    <div class="filter-grid">
      <div class="f-group">
        <div class="f-label">Job Type</div>
        <select class="f-select" id="fType">
          <option value="">All Types</option>
          <option value="fulltime">Full-time</option>
          <option value="contract">Contract</option>
          <option value="parttime">Part-time</option>
          <option value="internship">Internship</option>
        </select>
      </div>
      <div class="f-group">
        <div class="f-label">Experience Level</div>
        <select class="f-select" id="fLevel">
          <option value="">All Levels</option>
          <option value="junior">Junior</option>
          <option value="mid">Mid-level</option>
          <option value="senior">Senior</option>
        </select>
      </div>
      <div class="f-group">
        <div class="f-label">Industry</div>
        <select class="f-select" id="fIndustry">
          <option value="">All Industries</option>
          <option value="tech">Tech</option>
          <option value="healthcare">Healthcare</option>
          <option value="finance">Finance</option>
          <option value="aiml">AI/ML</option>
          <option value="cybersecurity">Cybersecurity</option>
          <option value="saas">SaaS</option>
        </select>
      </div>
      <div class="f-group">
        <div class="f-label">Posted</div>
        <select class="f-select" id="fDate">
          <option value="today">Last 24 Hours</option>
          <option value="week" selected>Last 7 Days</option>
          <option value="month">Last 30 Days</option>
          <option value="all">All Time</option>
        </select>
      </div>
      <div class="f-group">
        <div class="f-label">Sort By</div>
        <select class="f-select" id="fSort">
          <option value="date">Most Recent</option>
          <option value="match">Best Match</option>
          <option value="salary">Highest Salary</option>
          <option value="company">Company Name</option>
        </select>
      </div>
      <div class="f-group">
        <div class="f-label">Skills (comma separated)</div>
        <input class="f-input" id="fSkills" placeholder="react, python, aws...">
      </div>
    </div>

    <div class="salary-row">
      <input type="number" id="fSalMin" placeholder="Min salary ($)" style="padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
      <input type="number" id="fSalMax" placeholder="Max salary ($)" style="padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;outline:none">
    </div>

    <div class="checks-grid">
      <label class="check-item"><input type="checkbox" id="fRemote" checked> 🏠 Remote Only</label>
      <label class="check-item"><input type="checkbox" id="fUSA"> 🇺🇸 USA Only</label>
      <label class="check-item"><input type="checkbox" id="fNoLead" checked> 🚫 Exclude Leadership</label>
      <label class="check-item"><input type="checkbox" id="fNoStaff" checked> 🚫 Exclude Staffing Agencies</label>
      <label class="check-item"><input type="checkbox" id="fNoGov"> 🚫 Exclude Gov Jobs</label>
      <label class="check-item"><input type="checkbox" id="fVisa"> ✈️ Visa Sponsorship</label>
    </div>

    <div class="smart-filters">
      <span style="font-size:13px;font-weight:600;color:var(--sub);margin-right:4px">⚡ Smart:</span>
      <button class="smart-btn" onclick="smartFilter('best_match')" id="sf_best_match">🎯 Best Match for Me</button>
      <button class="smart-btn" onclick="smartFilter('high_salary')" id="sf_high_salary">💰 High Salary + Remote</button>
      <button class="smart-btn" onclick="smartFilter('easy_apply')" id="sf_easy_apply">⚡ Easy Apply</button>
      <button class="smart-btn" onclick="smartFilter('fast_growing')" id="sf_fast_growing">🚀 Fast Growing</button>
      <button class="smart-btn" onclick="smartFilter('low_competition')" id="sf_low_competition">🎯 Low Competition</button>
    </div>
  </div>

  <!-- STATS -->
  <div id="statsBar" style="display:none" class="stats-bar">
    <div>
      <div class="stat-num" id="statTotal">0</div>
      <div style="font-size:14px">Jobs Found</div>
    </div>
    <div class="source-tags" id="srcTags"></div>
  </div>

  <!-- LOADING -->
  <div id="loadState" class="loading" style="display:none">
    <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <p>Searching across 6 live job platforms...</p>
    <p style="font-size:13px;color:var(--sub);margin-top:8px" id="loadMsg">Fetching from RemoteOK, Remotive, The Muse...</p>
  </div>

  <!-- JOBS -->
  <div id="jobList" class="job-list">
    <div class="empty">
      <div class="empty-icon">🎯</div>
      <h3>Ready to find your dream job?</h3>
      <p>Use the search and filters above to discover remote opportunities</p>
    </div>
  </div>

  <!-- LOAD MORE -->
  <div id="loadMoreWrap" style="display:none;text-align:center;margin-top:24px">
    <button class="btn btn-outline" onclick="loadMore()">Load More Jobs</button>
  </div>
</div>

<!-- ══════════════ RESUME ANALYZER ══════════════ -->
<div id="page-resume" class="page">
  <div class="page-header">
    <h1>📄 AI Resume Analyzer</h1>
    <p style="color:var(--sub)">Get instant match score, ATS analysis, and improvement tips</p>
  </div>
  <div class="two-col">
    <div>
      <div class="card" style="margin-bottom:16px">
        <h3>Your Resume</h3>
        <textarea id="resumeTxt" rows="12" placeholder="Paste your full resume text here..."></textarea>
      </div>
      <div class="card">
        <h3>Job Description</h3>
        <textarea id="jobDescTxt" rows="10" placeholder="Paste the job description here..."></textarea>
        <button class="btn btn-primary" style="width:100%;margin-top:16px;justify-content:center" onclick="doAnalyze()" id="analyzeBtn">
          🔍 Analyze Match
        </button>
      </div>
    </div>
    <div id="resumeOut">
      <div class="card">
        <div class="empty">
          <div class="empty-icon">📊</div>
          <h3>Analysis Results</h3>
          <p>Paste your resume and a job description, then click Analyze</p>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ APPLICATION TRACKER ══════════════ -->
<div id="page-applications" class="page">
  <div class="page-header">
    <h1>📋 Application Tracker</h1>
    <p style="color:var(--sub)">Track all your job applications in one place</p>
  </div>
  <div class="kanban" id="kanbanBoard">
    <div class="empty" style="grid-column:1/-1">
      <div class="empty-icon">📋</div>
      <h3>No applications yet</h3>
      <p>Click "Track" on any job to add it here</p>
    </div>
  </div>
</div>

<!-- ══════════════ DASHBOARD ══════════════ -->
<div id="page-dashboard" class="page">
  <div class="page-header">
    <h1>📊 Your Dashboard</h1>
    <p style="color:var(--sub)">Job search analytics and insights</p>
  </div>
  <div class="dash-grid" id="dashCards">
    <div class="dash-card"><div class="dash-num" id="dTotal">0</div><div class="dash-label">Total Applications</div></div>
    <div class="dash-card"><div class="dash-num" id="dSaved">0</div><div class="dash-label">Saved Jobs</div></div>
    <div class="dash-card"><div class="dash-num" id="dRate">0%</div><div class="dash-label">Response Rate</div></div>
    <div class="dash-card"><div class="dash-num" id="dInterviews">0</div><div class="dash-label">Interviews</div></div>
  </div>
  <div class="card">
    <h3>💡 Job Search Tips</h3>
    <ul class="tip-list" style="margin-top:12px">
      <li>🎯 <span>Apply to 5-10 targeted jobs per week vs 100 random ones</span></li>
      <li>📄 <span>Customize your resume for each application using job keywords</span></li>
      <li>⏰ <span>Apply within the first 24 hours - response rate is 3x higher</span></li>
      <li>🤝 <span>Follow up politely 5-7 days after applying</span></li>
      <li>💼 <span>Build LinkedIn connections at target companies</span></li>
      <li>🔔 <span>Set up job alerts to be notified of new postings</span></li>
    </ul>
  </div>
</div>

<!-- ══════════════ AUTH PAGE ══════════════ -->
<div id="page-auth" class="page">
  <div class="auth-wrap">
    <div class="card" id="loginCard">
      <h2 style="margin-bottom:24px;text-align:center">👤 Login</h2>
      <div class="auth-form">
        <input type="email" id="loginEmail" placeholder="Email address">
        <input type="password" id="loginPass" placeholder="Password">
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">Login</button>
      </div>
      <div class="auth-toggle">Don't have an account? <a onclick="toggleAuth()">Sign up</a></div>
    </div>
    <div class="card" id="regCard" style="display:none">
      <h2 style="margin-bottom:24px;text-align:center">🚀 Create Account</h2>
      <div class="auth-form">
        <input type="text" id="regName" placeholder="Full name">
        <input type="email" id="regEmail" placeholder="Email address">
        <input type="password" id="regPass" placeholder="Password (min 6 chars)">
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doRegister()">Create Account</button>
      </div>
      <div class="auth-toggle">Already have an account? <a onclick="toggleAuth()">Login</a></div>
    </div>
  </div>
</div>

</div><!-- end .app -->

<!-- AI CHAT -->
<button class="chat-fab" onclick="toggleChat()">🤖</button>
<div id="chatPanel" class="chat-panel">
  <div class="chat-head">
    <div>
      <h3>🤖 AI Career Assistant</h3>
      <div style="font-size:12px;opacity:.8" id="aiProvider">Connecting...</div>
    </div>
    <button onclick="toggleChat()" style="background:rgba(255,255,255,.2);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px">×</button>
  </div>
  <div id="chatMsgs" class="chat-msgs">
    <div class="msg bot">
      👋 Hi! I'm your AI career assistant.<br><br>I can help with resume tips, interview prep, salary negotiation, and job search strategies. What do you need?
    </div>
  </div>
  <div class="chat-suggestions" id="chatSuggs">
    <button class="chat-sugg" onclick="quickChat('How do I optimize my resume for ATS?')">ATS Tips</button>
    <button class="chat-sugg" onclick="quickChat('Interview tips for remote jobs')">Interview Prep</button>
    <button class="chat-sugg" onclick="quickChat('How to negotiate salary?')">Salary Tips</button>
    <button class="chat-sugg" onclick="quickChat('Best remote job boards 2026')">Job Boards</button>
  </div>
  <div class="provider-tag" id="providerTag">Provider: Loading...</div>
  <div class="chat-foot">
    <input type="text" id="chatIn" placeholder="Ask anything..." onkeydown="if(event.key==='Enter')sendChat()">
    <button class="send-btn" onclick="sendChat()">➤</button>
  </div>
</div>

<!-- JOB MODAL -->
<div class="modal-backdrop" id="jobModal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()">✕</button>
    <div id="modalContent"></div>
  </div>
</div>

<!-- TOAST -->
<div class="toast-wrap" id="toasts"></div>

<script>
const API = '';
let token = localStorage.getItem('rh_token') || '';
let user = null;
let allJobs = [];
let currentPage = 1;
let currentFilters = {};
let savedJobIds = new Set(JSON.parse(localStorage.getItem('rh_saved')||'[]'));
let applications = JSON.parse(localStorage.getItem('rh_apps')||'[]');
let convId = null;
let activeSmartFilter = null;
let isDark = localStorage.getItem('rh_theme') === 'dark';

// ─── INIT ───
window.addEventListener('DOMContentLoaded', () => {
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  checkAuth();
  setTimeout(() => doSearch(), 300);
  renderDashboard();
});

function show(page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  if (btn) btn.classList.add('active');
  if (page === 'applications') renderKanban();
  if (page === 'dashboard') renderDashboard();
}

function toggleTheme() {
  isDark = !isDark;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : '');
  localStorage.setItem('rh_theme', isDark ? 'dark' : '');
}

// ─── SEARCH ───
async function doSearch(append = false) {
  const kw = document.getElementById('kw').value.trim();
  const skills = document.getElementById('fSkills').value.split(',').map(s=>s.trim()).filter(Boolean);
  
  currentFilters = {
    keywords: kw,
    remote_only: document.getElementById('fRemote').checked,
    usa_only: document.getElementById('fUSA').checked,
    employment_type: document.getElementById('fType').value,
    experience_level: document.getElementById('fLevel').value,
    industry: document.getElementById('fIndustry').value,
    exclude_leadership: document.getElementById('fNoLead').checked,
    exclude_staffing: document.getElementById('fNoStaff').checked,
    exclude_government: document.getElementById('fNoGov').checked,
    visa_sponsorship: document.getElementById('fVisa').checked || null,
    salary_min: document.getElementById('fSalMin').value || null,
    salary_max: document.getElementById('fSalMax').value || null,
    date_posted: document.getElementById('fDate').value,
    skills: skills,
    sort: document.getElementById('fSort').value,
    page: append ? currentPage : 1
  };

  if (!append) {
    currentPage = 1;
    allJobs = [];
    document.getElementById('jobList').innerHTML = '';
    document.getElementById('statsBar').style.display = 'none';
    document.getElementById('loadMoreWrap').style.display = 'none';
  }

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = '⏳';
  document.getElementById('loadState').style.display = 'block';

  const msgs = [
    'Fetching from RemoteOK...',
    'Searching Remotive...',
    'Checking The Muse...',
    'Scanning Arbeitnow...',
    'Looking on Findwork...',
    'Checking Jobicy...',
    'Applying AI filters...'
  ];
  let mi = 0;
  const msgEl = document.getElementById('loadMsg');
  const msgInterval = setInterval(() => {
    if (mi < msgs.length) { msgEl.textContent = msgs[mi++]; }
    else clearInterval(msgInterval);
  }, 800);

  try {
    const params = new URLSearchParams();
    Object.entries(currentFilters).forEach(([k,v]) => {
      if (v !== null && v !== '' && v !== false) {
        if (Array.isArray(v) && v.length > 0) params.set(k, v.join(','));
        else if (!Array.isArray(v)) params.set(k, v);
      }
    });
    
    if (token) params.set('auth', '1');

    const res = await fetch(\`\${API}/api/jobs/search?\${params}\`, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    const data = await res.json();

    clearInterval(msgInterval);

    if (data.success) {
      allJobs = append ? [...allJobs, ...data.jobs] : data.jobs;
      renderJobs(data.jobs, append);
      renderStats(data.total, data.sources);
      
      if (data.hasMore) {
        document.getElementById('loadMoreWrap').style.display = 'block';
        currentPage++;
      }
    }
  } catch (e) {
    clearInterval(msgInterval);
    toast('Search error: ' + e.message, 'error');
    renderDemoJobs();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
    document.getElementById('loadState').style.display = 'none';
  }
}

function loadMore() { doSearch(true); }

function qs(q) {
  document.getElementById('kw').value = q;
  doSearch();
}

function resetFilters() {
  document.getElementById('fType').value = '';
  document.getElementById('fLevel').value = '';
  document.getElementById('fIndustry').value = '';
  document.getElementById('fDate').value = 'week';
  document.getElementById('fSort').value = 'date';
  document.getElementById('fSkills').value = '';
  document.getElementById('fSalMin').value = '';
  document.getElementById('fSalMax').value = '';
  document.getElementById('fRemote').checked = true;
  document.getElementById('fUSA').checked = false;
  document.getElementById('fNoLead').checked = true;
  document.getElementById('fNoStaff').checked = true;
  document.getElementById('fNoGov').checked = false;
  document.getElementById('fVisa').checked = false;
  document.querySelectorAll('.smart-btn').forEach(b => b.classList.remove('active'));
  activeSmartFilter = null;
  doSearch();
}

function smartFilter(type) {
  const btn = document.getElementById('sf_' + type);
  
  if (activeSmartFilter === type) {
    btn.classList.remove('active');
    activeSmartFilter = null;
    resetFilters();
    return;
  }

  document.querySelectorAll('.smart-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeSmartFilter = type;

  switch(type) {
    case 'best_match':
      document.getElementById('fSort').value = 'match';
      document.getElementById('fRemote').checked = true;
      doSearch();
      break;
    case 'high_salary':
      document.getElementById('fSalMin').value = '100000';
      document.getElementById('fSort').value = 'salary';
      document.getElementById('fRemote').checked = true;
      doSearch();
      break;
    case 'easy_apply':
      document.getElementById('fDate').value = 'week';
      doSearch();
      break;
    case 'fast_growing':
      currentFilters.fast_growing = true;
      doSearch();
      break;
    case 'low_competition':
      document.getElementById('fDate').value = 'today';
      document.getElementById('fSort').value = 'date';
      doSearch();
      break;
  }
}

// ─── RENDER JOBS ───
function renderJobs(jobs, append) {
  const container = document.getElementById('jobList');
  
  if (!append) container.innerHTML = '';

  if (jobs.length === 0 && !append) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><h3>No jobs found</h3><p>Try different keywords or adjust your filters</p></div>';
    return;
  }

  jobs.forEach((job, i) => {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.onclick = () => openModal(job);
    
    const daysAgo = Math.floor((Date.now() - new Date(job.posted_date)) / 86400000);
    const isNew = daysAgo < 2;
    const isSaved = savedJobIds.has(job.id);
    const initials = (job.company || 'J').charAt(0).toUpperCase();
    
    card.innerHTML = \`
      <div class="jc-top">
        \${job.logo ? \`<img class="company-logo" src="\${job.logo}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">\` : ''}
        <div class="logo-placeholder" \${job.logo ? 'style="display:none"' : ''}>\${initials}</div>
        <div class="jc-info">
          <div class="jc-title">\${esc(job.title)}</div>
          <div class="jc-company">\${esc(job.company)}</div>
        </div>
        <div class="jc-score">\${job.match_score || 0}%</div>
      </div>
      <div class="jc-meta">
        <span>📍 \${esc(job.location)}</span>
        \${isNew ? '<span class="pill pill-new">✨ New</span>' : ''}
        \${job.remote ? '<span class="pill pill-remote">🏠 Remote</span>' : ''}
        \${job.salary_raw ? \`<span class="pill pill-salary">💰 \${esc(job.salary_raw)}</span>\` : ''}
        \${job.employment_type ? \`<span class="pill pill-type">\${esc(job.employment_type)}</span>\` : ''}
        <span>🕐 \${daysAgo === 0 ? 'Today' : daysAgo + 'd ago'}</span>
      </div>
      <div class="jc-desc">\${esc(job.description).substring(0,200)}...</div>
      \${job.skills?.length > 0 ? \`
        <div class="skill-tags">
          \${job.skills.slice(0,6).map(s=>\`<span class="skill-tag">\${esc(s)}</span>\`).join('')}
          \${job.skills.length > 6 ? \`<span class="skill-tag">+\${job.skills.length - 6}</span>\` : ''}
        </div>
      \` : ''}
      <div class="jc-footer">
        <span class="jc-source">\${job.source_icon || '🌐'} \${esc(job.source)}</span>
        <div class="jc-actions">
          <button class="save-btn \${isSaved?'saved':''}" onclick="event.stopPropagation();toggleSave(this,\${JSON.stringify(job).replace(/'/g,"\\'")})" title="Save job">
            \${isSaved ? '❤️' : '🤍'}
          </button>
          <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();trackApp(job_\${i})">📋 Track</button>
          <a href="\${job.apply_url || job.url}" target="_blank" class="btn btn-primary btn-sm" onclick="event.stopPropagation()">Apply →</a>
        </div>
      </div>
    \`;

    // Store job reference
    window[\`job_\${append ? allJobs.length - jobs.length + i : i}\`] = job;
    card.querySelector('.btn-outline').setAttribute('onclick', \`event.stopPropagation();trackApp(window.job_\${append ? allJobs.length - jobs.length + i : i})\`);

    container.appendChild(card);
  });
}

function renderStats(total, sources) {
  document.getElementById('statsBar').style.display = 'flex';
  document.getElementById('statTotal').textContent = total;
  
  const tagsEl = document.getElementById('srcTags');
  tagsEl.innerHTML = (sources || [])
    .filter(s => s.count > 0)
    .map(s => \`<span class="src-tag">✅ \${s.name}: \${s.count}</span>\`)
    .join('');
}

function renderDemoJobs() {
  const demos = [
    { id:'d1', title:'Senior React Developer', company:'TechCorp', location:'Remote', source:'Demo', source_icon:'📋', remote:true, salary_raw:'$120k-$160k', employment_type:'Full-time', description:'We are looking for an experienced React developer to join our remote team...', skills:['react','typescript','nodejs'], posted_date:new Date().toISOString(), apply_url:'#', match_score:85 },
    { id:'d2', title:'Python Backend Engineer', company:'DataStartup', location:'Remote, USA', source:'Demo', source_icon:'📋', remote:true, salary_raw:'$100k-$140k', employment_type:'Full-time', description:'Join our growing team as a Python backend engineer working on ML pipelines...', skills:['python','aws','docker','sql'], posted_date:new Date(Date.now()-86400000).toISOString(), apply_url:'#', match_score:72 },
    { id:'d3', title:'UX Designer (Remote)', company:'ProductCo', location:'Remote', source:'Demo', source_icon:'📋', remote:true, salary_raw:null, employment_type:'Contract', description:'Design beautiful user experiences for our SaaS platform...', skills:['figma','sketch','prototyping'], posted_date:new Date(Date.now()-172800000).toISOString(), apply_url:'#', match_score:65 }
  ];
  allJobs = demos;
  renderJobs(demos, false);
  renderStats(3, [{name:'Demo',count:3}]);
  toast('Showing demo data - Check your internet connection', 'info');
}

// ─── JOB MODAL ───
function openModal(job) {
  const daysAgo = Math.floor((Date.now() - new Date(job.posted_date)) / 86400000);
  
  document.getElementById('modalContent').innerHTML = \`
    <div style="margin-bottom:20px">
      <h2 style="font-size:24px;font-weight:800;margin-bottom:6px">\${esc(job.title)}</h2>
      <p style="color:var(--sub);font-size:16px;margin-bottom:16px">\${esc(job.company)} • \${esc(job.location)}</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
        \${job.remote ? '<span class="pill pill-remote">🏠 Remote</span>' : ''}
        \${job.salary_raw ? \`<span class="pill pill-salary">💰 \${esc(job.salary_raw)}</span>\` : ''}
        \${job.employment_type ? \`<span class="pill pill-type">\${esc(job.employment_type)}</span>\` : ''}
        <span class="pill" style="background:var(--bg);color:var(--sub)">🕐 \${daysAgo === 0 ? 'Posted today' : daysAgo + ' days ago'}</span>
        <span class="pill" style="background:linear-gradient(135deg,var(--p),var(--s));color:#fff">⚡ \${job.match_score || 0}% Match</span>
      </div>
    </div>
    \${job.skills?.length > 0 ? \`
      <div style="margin-bottom:20px">
        <h4 style="margin-bottom:10px">🎯 Skills</h4>
        <div class="skill-tags">
          \${job.skills.map(s=>\`<span class="skill-tag">\${esc(s)}</span>\`).join('')}
        </div>
      </div>
    \` : ''}
    <div style="margin-bottom:24px">
      <h4 style="margin-bottom:10px">📋 Job Description</h4>
      <div style="font-size:14px;line-height:1.8;color:var(--sub);white-space:pre-wrap">\${esc(job.description).substring(0,2000)}\${job.description?.length > 2000 ? '...' : ''}</div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:20px">
      <a href="\${job.apply_url || job.url || '#'}" target="_blank" class="btn btn-primary">🚀 Apply Now</a>
      <button class="btn btn-outline" onclick="loadJobToResume(\`\${esc(job.description)}\`)">📄 Analyze Match</button>
      <button class="btn btn-outline" onclick="closeModal();quickChat('Tips for applying to \${esc(job.title)} at \${esc(job.company)}')">🤖 Get AI Tips</button>
    </div>
  \`;
  
  document.getElementById('jobModal').classList.add('open');
}

function closeModal() {
  document.getElementById('jobModal').classList.remove('open');
}

function loadJobToResume(desc) {
  closeModal();
  document.getElementById('jobDescTxt').value = desc;
  show('resume', document.querySelectorAll('.nav-tab')[1]);
  toast('Job loaded! Paste your resume and click Analyze', 'info');
}

// ─── SAVE JOBS ───
function toggleSave(btn, job) {
  if (savedJobIds.has(job.id)) {
    savedJobIds.delete(job.id);
    btn.innerHTML = '🤍';
    btn.classList.remove('saved');
    toast('Job removed from saved', 'info');
  } else {
    savedJobIds.add(job.id);
    btn.innerHTML = '❤️';
    btn.classList.add('saved');
    toast('Job saved! ❤️', 'success');
  }
  localStorage.setItem('rh_saved', JSON.stringify([...savedJobIds]));
}

// ─── TRACK APPLICATION ───
function trackApp(job) {
  if (!job || !job.id) return;
  
  const existing = applications.find(a => a.jobId === job.id);
  if (existing) { toast('Already tracking this application', 'info'); return; }

  applications.push({
    id: 'app_' + Date.now(),
    jobId: job.id,
    job: job,
    status: 'applied',
    appliedDate: new Date().toISOString(),
    timeline: [{ status: 'applied', date: new Date().toISOString() }]
  });

  localStorage.setItem('rh_apps', JSON.stringify(applications));
  toast('Application tracked! 📋', 'success');
  renderDashboard();
}

// ─── KANBAN BOARD ───
function renderKanban() {
  const statuses = [
    { key: 'applied', label: '📨 Applied', color: '#6366f1' },
    { key: 'viewed', label: '👀 Viewed', color: '#f59e0b' },
    { key: 'interviewing', label: '🎤 Interviewing', color: '#06b6d4' },
    { key: 'offered', label: '🎉 Offered', color: '#10b981' },
    { key: 'rejected', label: '❌ Rejected', color: '#ef4444' }
  ];

  const board = document.getElementById('kanbanBoard');

  if (applications.length === 0) {
    board.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">📋</div><h3>No applications yet</h3><p>Click "Track" on any job card to track it</p></div>';
    return;
  }

  board.innerHTML = statuses.map(s => {
    const apps = applications.filter(a => a.status === s.key);
    return \`
      <div class="kanban-col">
        <div class="kanban-title" style="color:\${s.color}">\${s.label} (\${apps.length})</div>
        \${apps.length === 0 ? '<p style="font-size:13px;color:var(--sub);text-align:center;padding:20px 0">No applications</p>' :
          apps.map(a => \`
            <div class="app-card">
              <h4>\${esc(a.job.title)}</h4>
              <p>\${esc(a.job.company)}</p>
              <div class="app-date">\${new Date(a.appliedDate).toLocaleDateString()}</div>
              <div style="display:flex;gap:6px;margin-top:8px">
                <select style="font-size:12px;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" onchange="updateAppStatus('\${a.id}',this.value)">
                  \${statuses.map(st=>\`<option value="\${st.key}" \${a.status===st.key?'selected':''}>\${st.label}</option>\`).join('')}
                </select>
                <a href="\${a.job.apply_url||a.job.url||'#'}" target="_blank" style="font-size:12px;padding:4px 8px;background:var(--p);color:#fff;border-radius:4px;text-decoration:none">Apply</a>
              </div>
            </div>
          \`).join('')
        }
      </div>
    \`;
  }).join('');
}

function updateAppStatus(id, status) {
  const app = applications.find(a => a.id === id);
  if (app) {
    app.status = status;
    app.timeline = [...(app.timeline || []), { status, date: new Date().toISOString() }];
    localStorage.setItem('rh_apps', JSON.stringify(applications));
    renderDashboard();
    toast('Status updated to: ' + status, 'success');
  }
}

// ─── DASHBOARD ───
function renderDashboard() {
  const total = applications.length;
  const saved = savedJobIds.size;
  const interviews = applications.filter(a => a.status === 'interviewing' || a.status === 'offered').length;
  const rate = total > 0 ? Math.round(interviews / total * 100) : 0;

  const dTotal = document.getElementById('dTotal');
  const dSaved = document.getElementById('dSaved');
  const dRate = document.getElementById('dRate');
  const dInterviews = document.getElementById('dInterviews');

  if (dTotal) dTotal.textContent = total;
  if (dSaved) dSaved.textContent = saved;
  if (dRate) dRate.textContent = rate + '%';
  if (dInterviews) dInterviews.textContent = interviews;
}

// ─── RESUME ANALYZER ───
async function doAnalyze() {
  const resume = document.getElementById('resumeTxt').value.trim();
  const jd = document.getElementById('jobDescTxt').value.trim();

  if (!resume || !jd) {
    toast('Please provide both resume and job description', 'error');
    return;
  }

  const btn = document.getElementById('analyzeBtn');
  btn.textContent = '⏳ Analyzing...';
  btn.disabled = true;

  try {
    const res = await fetch(\`\${API}/api/resume/analyze\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: resume, jobDescription: jd })
    });
    const data = await res.json();

    if (data.success) {
      renderAnalysis(data.analysis);
      toast('Analysis complete! 📊', 'success');
    }
  } catch (e) {
    toast('Analysis failed: ' + e.message, 'error');
  } finally {
    btn.textContent = '🔍 Analyze Match';
    btn.disabled = false;
  }
}

function renderAnalysis(a) {
  const score = a.matchScore || 0;
  const color = score >= 70 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';
  const label = score >= 80 ? 'Excellent' : score >= 60 ? 'Good Match' : score >= 40 ? 'Fair Match' : 'Needs Work';
  const circ = 2 * Math.PI * 55;
  const offset = circ - (score / 100) * circ;

  document.getElementById('resumeOut').innerHTML = \`
    <div class="card" style="text-align:center;margin-bottom:16px">
      <h3>Overall Match Score</h3>
      <div class="score-ring" style="margin:20px auto">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="55" fill="none" stroke="var(--border)" stroke-width="10"/>
          <circle cx="60" cy="60" r="55" fill="none" stroke="\${color}" stroke-width="10"
            stroke-dasharray="\${circ}" stroke-dashoffset="\${offset}" stroke-linecap="round"
            style="transition:stroke-dashoffset 1.2s ease"/>
        </svg>
        <div class="score-text">
          <div class="score-num" style="color:\${color}">\${score}%</div>
          <div class="score-lbl">\${label}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:16px">
        \${[['Tech Skills', a.techScore, '#6366f1'], ['Soft Skills', a.softScore, '#06b6d4'], ['ATS Score', a.atsScore, '#10b981']].map(([lbl, val, c]) => \`
          <div style="text-align:center">
            <div style="font-size:22px;font-weight:800;color:\${c}">\${val || 0}%</div>
            <div style="font-size:12px;color:var(--sub)">\${lbl}</div>
            <div class="progress-bar"><div class="progress-fill" style="width:\${val||0}%;background:\${c}"></div></div>
          </div>
        \`).join('')}
      </div>
    </div>

    \${a.matchingSkills?.length > 0 ? \`
      <div class="card" style="margin-bottom:16px">
        <h3>✅ Matching Skills (\${a.matchingSkills.length})</h3>
        <div class="pills-wrap">
          \${a.matchingSkills.map(s=>\`<span class="match-pill found">\${esc(s)}</span>\`).join('')}
        </div>
      </div>
    \` : ''}

    \${a.missingSkills?.length > 0 ? \`
      <div class="card" style="margin-bottom:16px">
        <h3>❌ Missing Skills (\${a.missingSkills.length})</h3>
        <div class="pills-wrap">
          \${a.missingSkills.map(s=>\`<span class="match-pill missing">\${esc(s)}</span>\`).join('')}
        </div>
      </div>
    \` : ''}

    \${a.improvements?.length > 0 ? \`
      <div class="card" style="margin-bottom:16px">
        <h3>💡 How to Improve</h3>
        <ul class="tip-list">
          \${a.improvements.map(tip=>\`<li>💡 <span>\${esc(tip)}</span></li>\`).join('')}
        </ul>
      </div>
    \` : ''}

    \${a.aiAnalysis ? \`
      <div class="card">
        <h3>🤖 AI Analysis</h3>
        <p style="font-size:14px;line-height:1.8;color:var(--sub);margin-top:8px">\${esc(a.aiAnalysis)}</p>
      </div>
    \` : ''}
  \`;
}

// ─── AI CHAT ───
function toggleChat() {
  const panel = document.getElementById('chatPanel');
  panel.classList.toggle('open');
  checkAIStatus();
}

async function checkAIStatus() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const provider = data.features?.aiProvider || 'Local';
    document.getElementById('aiProvider').textContent = 'AI: ' + provider;
    document.getElementById('providerTag').textContent = 'Provider: ' + provider + ' (Free)';
  } catch {}
}

async function sendChat() {
  const input = document.getElementById('chatIn');
  const msg = input.value.trim();
  if (!msg) return;

  addMsg(msg, 'user');
  input.value = '';

  const typingId = addTyping();

  try {
    const res = await fetch(\`\${API}/api/chat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, conversationId: convId })
    });
    const data = await res.json();

    removeTyping(typingId);

    if (data.success) {
      convId = data.conversationId;
      addMsg(data.response.message, 'bot');
      document.getElementById('providerTag').textContent = 'Provider: ' + data.response.provider + ' (Free)';
    }
  } catch (e) {
    removeTyping(typingId);
    addMsg('Connection error. Please check your internet.', 'bot');
  }
}

function quickChat(msg) {
  document.getElementById('chatIn').value = msg;
  sendChat();
  document.getElementById('chatSuggs').style.display = 'none';
}

function addMsg(text, role) {
  const msgs = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = text.replace(/\\n/g, '<br>').replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function addTyping() {
  const id = 'typing_' + Date.now();
  const msgs = document.getElementById('chatMsgs');
  msgs.innerHTML += \`<div id="\${id}" class="msg bot"><div class="typing"><span></span><span></span><span></span></div></div>\`;
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ─── AUTH ───
function toggleAuth() {
  const login = document.getElementById('loginCard');
  const reg = document.getElementById('regCard');
  login.style.display = login.style.display === 'none' ? 'block' : 'none';
  reg.style.display = reg.style.display === 'none' ? 'block' : 'none';
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPass').value;
  
  if (!email || !password) { toast('Please fill all fields', 'error'); return; }

  try {
    const res = await fetch(\`\${API}/api/auth/login\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (data.success) {
      token = data.token;
      user = data.user;
      localStorage.setItem('rh_token', token);
      show('search', document.querySelectorAll('.nav-tab')[0]);
      toast('Welcome back, ' + user.name + '! 👋', 'success');
      document.getElementById('authBtn').textContent = user.name.charAt(0).toUpperCase();
    } else {
      toast(data.error, 'error');
    }
  } catch (e) {
    toast('Login failed: ' + e.message, 'error');
  }
}

async function doRegister() {
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPass').value;

  if (!name || !email || !password) { toast('Please fill all fields', 'error'); return; }
  if (password.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }

  try {
    const res = await fetch(\`\${API}/api/auth/register\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();

    if (data.success) {
      token = data.token;
      user = data.user;
      localStorage.setItem('rh_token', token);
      show('search', document.querySelectorAll('.nav-tab')[0]);
      toast('Account created! Welcome ' + name + '! 🎉', 'success');
      document.getElementById('authBtn').textContent = name.charAt(0).toUpperCase();
    } else {
      toast(data.error, 'error');
    }
  } catch (e) {
    toast('Registration failed: ' + e.message, 'error');
  }
}

async function checkAuth() {
  if (!token) return;
  try {
    const res = await fetch(\`\${API}/api/auth/me\`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.success) {
      user = data.user;
      document.getElementById('authBtn').textContent = user.name.charAt(0).toUpperCase();
    } else {
      token = '';
      localStorage.removeItem('rh_token');
    }
  } catch {}
}

// ─── HELPERS ───
function toast(msg, type = 'info') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = (type === 'success' ? '✅ ' : type === 'error' ? '❌ ' : 'ℹ️ ') + msg;
  wrap.appendChild(el);
  setTimeout(() => el.style.opacity = '0', 3000);
  setTimeout(() => el.remove(), 3400);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;

// Start
app.listen(PORT, () => {
  console.log(`🚀 RemoteHunt 2026 LIVE on port ${PORT}`);
});
