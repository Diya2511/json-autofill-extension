/* Matching rules and domain-specific mapping persistence for JSON Autofill Pro. */

const JsonAutofillMapping = (() => {
  const { normalizeKey, tokenize, unique, STORAGE_KEYS, getDomain } = JsonAutofillUtils;

  const CANONICAL_SYNONYMS = {
    firstName: ["first name", "firstname", "given name", "forename", "fname", "applicant first name", "candidate first name"],
    middleName: ["middle name", "middlename", "mname", "middle initial"],
    lastName: ["last name", "lastname", "surname", "family name", "lname", "applicant last name", "candidate last name"],
    fullName: ["full name", "name", "your name", "applicant name", "candidate name"],
    email: ["email", "e mail", "email address", "mail", "user email", "work email"],
    phone: ["phone", "mobile", "telephone", "tel", "contact number", "phone number", "mobile number", "cell", "cellphone"],
    address: ["address", "street address", "address line", "address1", "address line 1", "mailing address"],
    address2: ["address 2", "address line 2", "suite", "apartment", "apt", "unit"],
    city: ["city", "town", "municipality"],
    state: ["state", "province", "region", "territory"],
    country: ["country", "nation"],
    zip: ["zip", "zipcode", "zip code", "postal", "postal code", "pin", "pincode", "pin code"],
    company: ["company", "organization", "organisation", "employer", "current company", "company name"],
    designation: ["designation", "title", "job title", "role", "position", "current role"],
    experience: ["experience", "years experience", "total experience", "work experience", "exp"],
    website: ["website", "url", "portfolio", "linkedin", "profile url"],
    dateOfBirth: ["date of birth", "dob", "birth date", "birthday"],
    gender: ["gender", "sex"],
    password: ["password", "passcode", "new password"],
    confirmPassword: ["confirm password", "password confirmation", "re enter password", "repeat password"],
    username: ["username", "user name", "login", "userid", "user id"],
    resume: ["resume", "cv", "curriculum vitae", "upload resume", "resume upload"],
    coverLetter: ["cover letter", "motivation letter"],
    salary: ["salary", "expected salary", "current salary", "compensation", "ctc"],
    noticePeriod: ["notice period", "availability", "joining time"],
    skills: ["skills", "technologies", "tech stack", "expertise"],
    education: ["education", "qualification", "degree"],
    college: ["college", "university", "school", "institute"],
    graduationYear: ["graduation year", "passing year", "year of graduation"],
    linkedIn: ["linkedin", "linked in", "linkedin url", "linkedin profile"],
    github: ["github", "git hub", "github url", "github profile"]
  };

  const canonicalByNormalized = new Map();
  Object.entries(CANONICAL_SYNONYMS).forEach(([canonical, synonyms]) => {
    [canonical, ...synonyms].forEach((alias) => canonicalByNormalized.set(normalizeKey(alias), canonical));
  });

  function canonicalize(value) {
    const normalized = normalizeKey(value);
    return canonicalByNormalized.get(normalized) || normalized;
  }

  function keyVariants(key) {
    const parts = String(key).split(".");
    const leaf = parts.at(-1);
    return unique([key, leaf, canonicalize(key), canonicalize(leaf), key.replace(/\./g, " ")]);
  }

  function extractFormCodes(value) {
    const text = String(value || "");
    const codes = new Set();
    const directMatches = text.match(/\b[A-Z]\s*\.\s*\d+[a-z]?\b/gi) || [];
    directMatches.forEach((match) => codes.add(match.replace(/\s+/g, "").toUpperCase()));

    const slashMatches = text.match(/\b[A-Z]\s*\.\s*\d+[a-z]?(?:\s*\/\s*[A-Z]?\s*\.?\s*\d+[a-z]?)+/gi) || [];
    slashMatches.forEach((match) => {
      const firstLetter = (match.match(/[A-Z]/i) || [""])[0].toUpperCase();
      match.split("/").forEach((part) => {
        const cleaned = part.trim();
        const full = cleaned.match(/[A-Z]\s*\.\s*\d+[a-z]?/i);
        const short = cleaned.match(/\d+[a-z]?/i);
        if (full) codes.add(full[0].replace(/\s+/g, "").toUpperCase());
        else if (firstLetter && short) codes.add(`${firstLetter}.${short[0]}`.toUpperCase());
      });
    });

    return [...codes];
  }

  function scoreCandidate(jsonKey, fieldSignals, options = {}) {
    const strict = Boolean(options.strict);
    const variants = keyVariants(jsonKey);
    const signalTexts = fieldSignals.map(String);
    const normalizedSignals = signalTexts.map(normalizeKey);
    const canonicalSignals = signalTexts.map(canonicalize);
    const keyCodes = extractFormCodes(jsonKey);
    const signalCodes = new Set(signalTexts.flatMap(extractFormCodes));

    if (keyCodes.some((code) => signalCodes.has(code))) return 0.995;

    for (const variant of variants) {
      const normalizedVariant = normalizeKey(variant);
      const canonicalVariant = canonicalize(variant);
      if (normalizedSignals.includes(normalizedVariant)) return 1;
      if (canonicalSignals.includes(canonicalVariant)) return 0.96;
    }

    if (strict) return 0;

    const keyTokens = new Set(tokenize(variants.join(" ")).map(canonicalize));
    let best = 0;
    for (const signal of signalTexts) {
      const signalTokens = tokenize(signal).map(canonicalize);
      const signalSet = new Set(signalTokens);
      const overlap = [...keyTokens].filter((token) => signalSet.has(token)).length;
      const denominator = Math.max(keyTokens.size, signalSet.size, 1);
      const score = overlap / denominator;
      if (score > best) best = score;
      if (normalizeKey(signal).includes(normalizeKey(jsonKey)) || normalizeKey(jsonKey).includes(normalizeKey(signal))) {
        best = Math.max(best, 0.78);
      }
    }

    return best;
  }

  function bestJsonKeyForField(jsonKeys, fieldSignals, options = {}) {
    const threshold = options.strict ? 0.9 : 0.58;
    let best = { key: null, score: 0 };
    for (const key of jsonKeys) {
      const score = scoreCandidate(key, fieldSignals, options);
      if (score > best.score) best = { key, score };
    }
    return best.score >= threshold ? best : { key: null, score: best.score };
  }

  async function loadAllMappings() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.mappings);
    return data[STORAGE_KEYS.mappings] || {};
  }

  async function loadDomainMappings(domain = getDomain()) {
    const all = await loadAllMappings();
    return all[domain] || {};
  }

  async function saveDomainMapping(domain, fieldSignature, jsonKey) {
    const all = await loadAllMappings();
    all[domain] = all[domain] || {};
    all[domain][fieldSignature] = jsonKey;
    await chrome.storage.local.set({ [STORAGE_KEYS.mappings]: all });
    return all[domain];
  }

  async function replaceDomainMappings(domain, mappings) {
    const all = await loadAllMappings();
    all[domain] = mappings || {};
    await chrome.storage.local.set({ [STORAGE_KEYS.mappings]: all });
  }

  async function clearDomainMappings(domain = getDomain()) {
    const all = await loadAllMappings();
    delete all[domain];
    await chrome.storage.local.set({ [STORAGE_KEYS.mappings]: all });
  }

  function fieldSignature(field) {
    const signals = JsonAutofillUtils.getFieldSignals(field).map(normalizeKey).filter(Boolean);
    if (field.name) return `name:${normalizeKey(field.name)}`;
    if (field.id) return `id:${normalizeKey(field.id)}`;
    return `signals:${signals.slice(0, 3).join("|")}`;
  }

  return {
    CANONICAL_SYNONYMS,
    canonicalize,
    extractFormCodes,
    keyVariants,
    scoreCandidate,
    bestJsonKeyForField,
    loadAllMappings,
    loadDomainMappings,
    saveDomainMapping,
    replaceDomainMappings,
    clearDomainMappings,
    fieldSignature
  };
})();
