// Converts a Qualtrics survey export (.qsf, JSON) into a LimeSurvey survey structure (.lss, XML).
// Runs unchanged in the browser and in Node. Entry point: convert(qsfTextOrObject, settings).
//
// settings (all optional):
//   choices: { problemId: optionKey }  how to resolve a problem, picked from that problem's options
//   edits:   { QID: { skip, code, mandatory } }  leave a question out, rename its code, or set "Y"/"S"/"N"
//   title:   survey title
//
// Result: { lss, problems, decided, notes, items, stats }
//   problems: things that cannot be converted faithfully. While any remain, lss is empty. Each has an id and
//             options; passing { choices: { [id]: option.key } } resolves it (it then moves to decided, with `chosen`,
//             and the choice is listed as a note).
//   notes:    things that were converted with a visible difference (layout, wording, data columns).
//   items:    the survey's questions, in flow order, for editing: { id, code, type, text, block, mandatory, skip }
// Problems and notes are { where, issue, fix }.

const LANGS = {
  EN: 'en', 'EN-GB': 'en', 'EN-US': 'en', NL: 'nl', DE: 'de', FR: 'fr', 'FR-CA': 'fr', ES: 'es', 'ES-ES': 'es',
  'ES-419': 'es-MX', IT: 'it', PT: 'pt', 'PT-BR': 'pt-BR', 'ZH-S': 'zh-Hans', 'ZH-T': 'zh-Hant-TW', JA: 'ja',
  KO: 'ko', RU: 'ru', PL: 'pl', SV: 'sv', DA: 'da', FI: 'fi', NO: 'nb', TR: 'tr', AR: 'ar', HE: 'he', EL: 'el',
  CS: 'cs', HU: 'hu', RO: 'ro', UK: 'uk', VI: 'vi', TH: 'th', ID: 'id', MS: 'ms', HI: 'hi', SK: 'sk', SL: 'sl',
  HR: 'hr', SR: 'sr', BG: 'bg', LT: 'lt', LV: 'lv', ET: 'et', CA: 'ca', EU: 'eu', GL: 'gl', IS: 'is', FA: 'fa',
};

const THEMES = {
  S: 'shortfreetext', T: 'longfreetext', U: 'hugefreetext', Q: 'multipleshorttext', N: 'numerical',
  K: 'multiplenumeric', L: 'listradio', '!': 'list_dropdown', M: 'multiplechoice', D: 'date', R: 'ranking',
  F: 'arrays/array', H: 'arrays/column', ';': 'arrays/texts', ':': 'arrays/multiflexi', X: 'boilerplate', '*': 'equation', '|': 'file_upload',
};

const UNSUPPORTED = {
  SS: 'Use a File upload question where respondents upload a signed form, or a signature plugin.',
  Draw: 'Use a File upload question for the drawing.',
  HeatMap: 'Use a Hot spot question in Qualtrics (regions convert to a multiple choice list), or a Multiple choice question that lists the image regions.',
  PGR: 'Use an Array question with the groups as columns, then a Ranking question per group.',
  DD: 'Use one Dropdown list question per level, filtered with relevance on the previous level.',
  TreeSelect: 'Use one Dropdown list question per level, filtered with relevance on the previous level.',
  GAP: 'Use two Array questions with the same rows (one per side of the gap).',
  Map: 'Use a Short text question with the map (location) option in LimeSurvey.',
  ScreenCapture: 'Use a File upload question.',
  Highlight: 'Use a Multiple choice question that lists the words or phrases to pick.',
  Video: 'Use a File upload question.',
  Conjoint: 'Build the choice tasks as List questions, or use a conjoint plugin.',
  Captcha: '',
};

const opt = (key, label, impact = '') => ({ key, label, impact });
// Options for a condition that cannot be checked: what "always true" and "always false" mean depends on where it is used.
function condOptions(where) {
  const [yes, no] = /: skip$/.test(where) ? ['The skip always happens, for every respondent.', 'The skip never happens; everyone sees the questions after it.']
    : /\(branch\)$/.test(where) ? ['Everyone follows this path: its questions are shown to every respondent.', 'Nobody follows this path: its questions are never shown.']
    : /when it is shown$/.test(where) ? ['It is shown to every respondent.', 'It is never shown, to anyone.']
    : /when a loop round is shown$/.test(where) ? ['This loop round is shown to every respondent.', 'This loop round is never shown.']
      : /answer check$/.test(where) ? ['The answer check always passes.', 'The answer check always fails, so respondents cannot continue.']
        : ['The condition counts as met for every respondent.', 'The condition counts as not met for anyone.'];
  return [opt('true', 'Treat it as always met', yes), opt('false', 'Treat it as never met', no)];
}
const BLANK = opt('blank', 'Leave that part of the text blank', 'Respondents see the text without the missing value.');
const CANT_CHECK = 'LimeSurvey has no way to check this condition, so you decide how it should behave for everyone.';
const TYPE_NAMES = {
  MC: 'Multiple choice', Matrix: 'Matrix', TE: 'Text entry', DB: 'Text / graphic', Slider: 'Slider', CS: 'Constant sum',
  RO: 'Rank order', SBS: 'Side by side', FileUpload: 'File upload', HotSpot: 'Hot spot', HL: 'Highlight', Timing: 'Timing',
  Meta: 'Meta info', Captcha: 'Captcha', SS: 'Signature', Draw: 'Drawing', HeatMap: 'Heat map', PGR: 'Pick, group & rank',
  DD: 'Drill down', TreeSelect: 'Tree select', GAP: 'Gap analysis', Map: 'Map', ScreenCapture: 'Screen capture',
  Highlight: 'Highlight', Video: 'Video', Conjoint: 'Conjoint',
};

export function convert(input, settings = {}) {
  const qsf = typeof input === 'string' ? JSON.parse(input.replace(/^\uFEFF/, '')) : structuredClone(input); // conversion annotates the parsed file
  if (!qsf || !Array.isArray(qsf.SurveyElements)) throw new Error('This is not a Qualtrics .qsf file (SurveyElements missing).');
  return new Converter(qsf, settings).run();
}

class Converter {
  constructor(qsf, settings) {
    this.qsf = qsf;
    this.choices = settings.choices || {};
    this.edits = settings.edits || {};
    this.items = [];
    this.decided = [];
    this.problems = [];
    this.notes = [];
    this.questions = {}; // QID -> payload
    this.blocks = {}; // block ID -> block
    this.models = {}; // QID or QID#iteration -> converted question
    this.groups = [];
    this.codes = new Set();
    this.vars = {}; // embedded data field -> hidden question model
    this.ends = []; // conditions that end the survey, in flow order
    this.nextId = 1;
    this.savetimings = false;
    this.quotas = [];
    this.scores = {}; // scoring category ID -> { name }
    this.redirects = []; // { conds, url } in flow order
    for (const el of qsf.SurveyElements) {
      const p = el.Payload;
      if (el.Element === 'SQ') this.questions[p.QuestionID] = p;
      else if (el.Element === 'BL') for (const b of values(p)) this.blocks[b.ID] = b;
      else if (el.Element === 'FL') this.flow = p;
      else if (el.Element === 'SO') this.options = p || {};
      else if (el.Element === 'QO' && p) this.quotas.push(...(p.Quotas ? values(p.Quotas) : [p]));
      else if (el.Element === 'SCO' && p) for (const c of values(p.ScoringCategories)) this.scores[c.ID] = { name: c.Name || c.ID };
    }
    this.options = this.options || {};
    const entry = qsf.SurveyEntry || {};
    this.lang = lang(entry.SurveyLanguage || 'EN');
    const avail = Object.keys(this.options.AvailableLanguages || {}).map(k => [k, lang(k)]);
    this.qLangs = avail.filter(([, l]) => l !== this.lang); // [qualtricsCode, lsCode]
    this.langs = [this.lang, ...new Set(this.qLangs.map(([, l]) => l))];
    this.title = String(settings.title || '').trim() || entry.SurveyName || 'Survey';
    this.sid = 100000 + (hash(entry.SurveyID || this.title) % 900000);
  }

  run() {
    if (!this.flow) this.problem('Survey flow', 'The file has no survey flow.', 'Export the survey again from Qualtrics.');
    this.varGroup = this.newGroup('Variables', [], '');
    this.walk(this.flow ? this.flow.Flow || [] : [], [], '');
    for (const it of this.items) it.lsCode = (this.models[it.id] || {}).code || '';
    for (const g of this.groups) for (const q of g.questions) this.finishQuestion(q);
    this.scoreGroup();
    for (const g of this.groups) this.finishGroup(g);
    this.quotaRows = this.quotas.map((qo, i) => this.quota(qo, i + 1)).filter(Boolean);
    this.endUrl();
    this.surveyOptions();
    const groups = this.groups.filter(g => g.questions.length);
    const lss = this.writeLss(groups);
    if (lss.includes('TOKEN:')) this.note('Contact details', 'The survey uses contact details from Qualtrics (name, email or external reference). LimeSurvey only knows these for people on a participant list.', 'In LimeSurvey, add a participant list (Survey participants) and send the invitations from there.');
    if (/qualtrics\.com\/(ControlPanel|CP)\/(Graphic|File)\.php/i.test(lss)) this.note('Images and files', 'Some images or files are still loaded from your Qualtrics account. They stop working when that account closes.', 'Download them from Qualtrics, upload them to LimeSurvey and replace the links.');
    return {
      lss: this.problems.length ? '' : lss,
      problems: this.problems,
      notes: this.notes,
      items: this.items,
      decided: this.decided,
      stats: { groups: groups.length, questions: groups.reduce((n, g) => n + g.questions.length, 0), languages: this.langs },
    };
  }

  // Returns the key of the option the user picked for this problem, if any; otherwise records the problem.
  // explain: { qualtrics: what Qualtrics does here, why: why a decision is needed }; each option says its impact.
  problem(where, issue, fix, options = [], explain = {}) {
    const id = 'p' + hash(where + '|' + issue).toString(36);
    const { qualtrics = '', why = '' } = explain;
    const pick = options.find(o => o.key === this.choices[id]);
    if (pick) {
      add(this.notes, { where, issue, fix: `Your choice: ${pick.label}.` });
      if (!this.decided.some(d => d.id === id)) this.decided.push({ id, where, issue, qualtrics, why, fix, options, chosen: pick.key });
      return pick.key;
    }
    add(this.problems, { id, where, issue, qualtrics, why, fix, options });
  }
  // A condition that cannot be converted: the user decides whether it counts as true or false.
  condProblem(where, issue, fix, explain = {}) { return this.problem(where, issue, fix, condOptions(where), { why: CANT_CHECK, ...explain }) === 'false' ? '0' : '1'; }
  note(where, issue, fix = '') { add(this.notes, { where, issue, fix }); }

  // A readable name for a survey flow element, e.g. 'Randomizer 2 (blocks "Intro", "Main")'.
  flowName(f) {
    this.flowNames = this.flowNames || {};
    if (!this.flowNames[f.FlowID]) {
      const label = { BlockRandomizer: 'Randomizer', Randomizer: 'Randomizer', EndSurvey: 'End of survey element', TableOfContents: 'Table of contents', WebService: 'Web service' }[f.Type] || f.Type;
      const n = this.flowCount = this.flowCount || {};
      n[label] = (n[label] || 0) + 1;
      const blocks = (f.Flow || []).map(k => this.blocks[k.ID] && `"${strip(this.blocks[k.ID].Description || k.ID)}"`).filter(Boolean);
      this.flowNames[f.FlowID] = `${label} ${n[label]}` + (blocks.length ? ` (block${blocks.length > 1 ? 's' : ''} ${blocks.slice(0, 3).join(', ')}${blocks.length > 3 ? ', ...' : ''})` : '');
    }
    return this.flowNames[f.FlowID];
  }

  // ---------- survey flow ----------

  walk(flow, conds, rgroup) {
    for (const f of flow) {
      if (this.stopped) return;
      switch (f.Type) {
        case 'Block':
        case 'Standard':
          this.addBlock(f.ID, conds, rgroup);
          break;
        case 'Branch':
          this.walk(f.Flow || [], [...conds, { logic: f.BranchLogic, where: `Survey path "${strip(f.Description || f.FlowID)}" (branch)` }], rgroup);
          break;
        case 'Group':
          this.walk(f.Flow || [], conds, rgroup);
          break;
        case 'Authenticator':
          this.note(this.flowName(f), 'In Qualtrics, respondents had to log in before these questions. In LimeSurvey, anyone with the survey link can answer them.', 'To require a login, add a participant list in LimeSurvey (Survey participants). Only people with an invitation code can then take part.');
          this.walk(f.Flow || [], conds, rgroup);
          break;
        case 'TableOfContents':
          this.questionIndex = true;
          this.note(this.flowName(f), 'The table of contents is replaced by the LimeSurvey question index, which also lets respondents jump between pages.');
          this.walk(f.Flow || [], conds, rgroup);
          break;
        case 'EmbeddedData':
          for (const ed of f.EmbeddedData || []) this.embedded(ed, conds);
          break;
        case 'BlockRandomizer':
        case 'Randomizer':
          this.randomizer(f, conds);
          break;
        case 'EndSurvey':
          this.endSurvey(f, conds);
          break;
        default:
          if (this.problem(this.flowName(f), f.Type === 'WebService' ? 'The survey calls a web service, which LimeSurvey cannot do.' : `The survey flow has a "${f.Type}" element, which LimeSurvey does not have.`,
            f.Type === 'WebService' ? 'Remove the web service from the flow; call the service from a LimeSurvey plugin or after export.'
              : 'Remove this element from the survey flow and rebuild it in LimeSurvey.',
            [opt('skip', 'Leave it out', f.Type === 'WebService' ? 'The service is never called, and any fields it filled stay empty.' : 'This step does not happen in LimeSurvey.'),
              ...(f.Flow ? [opt('keep', 'Leave it out, keep the blocks inside', 'The questions inside it are still asked; only this element\'s own behaviour is lost.')] : [])],
            { qualtrics: f.Type === 'WebService' ? 'While respondents take the survey, Qualtrics sends information to another website and can save what comes back with the response.' : `Qualtrics runs this "${f.Type}" step at this point of the survey flow.`,
              why: 'There is no LimeSurvey equivalent, so this step cannot be copied as it is.' }) === 'keep') this.walk(f.Flow, conds, rgroup);
      }
    }
  }

  randomizer(f, conds) {
    const kids = f.Flow || [];
    const n = kids.length;
    const subset = Math.min(Number(f.SubSet) || n, n);
    const allBlocks = kids.every(k => k.Type === 'Block' || k.Type === 'Standard');
    const rg = allBlocks ? `rg${this.nextId++}` : '';
    if (f.EvenPresentation && subset < n) this.note(this.flowName(f), 'Qualtrics shows each option to the same number of people. LimeSurvey picks at random, so the groups end up roughly equal, not exactly equal.', 'If the groups must be exactly equal, set up quotas in LimeSurvey (Survey settings, Quotas).');
    if (!allBlocks && subset >= n && kids.length > 1) this.note(this.flowName(f), 'The items in this randomizer that are not blocks (such as saving hidden values) now always run in the same order.');
    if (subset >= n) return this.walk(kids, conds, rg);
    // Pick `subset` of n children: every child draws a random number once; a child is shown when fewer
    // than `subset` other children drew a lower number.
    const names = kids.map((_, i) => this.varName(`rnd${f.FlowID.replace(/\W/g, '')}x${i + 1}`));
    for (const v of names) this.assign(v, `if(is_empty(${v}.NAOK), rand(1, 1000000), ${v}.NAOK)`, conds);
    kids.forEach((k, i) => {
      const rank = names.filter((_, j) => j !== i).map(o => `(${o}.NAOK < ${names[i]}.NAOK)`).join(' + ');
      this.walk([k], [...conds, { expr: `(${rank}) < ${subset}` }], rg);
    });
  }

  endSurvey(f, conds) {
    const o = f.Options || {};
    if (o.EOSRedirectURL && /^https?:\/\/./.test(o.EOSRedirectURL) && (o.SurveyTermination === 'Redirect' || f.EndingType === 'Redirect')) {
      this.redirects.push({ conds, url: o.EOSRedirectURL, where: this.flowName(f) });
    }
    if (o.EOSMessage) this.note(this.flowName(f), 'Your own end-of-survey message is stored in the Qualtrics library, so it is not part of the export. Respondents see the standard LimeSurvey message.', 'Copy the message from Qualtrics and paste it into LimeSurvey under Settings, Text elements, End message.');
    if (!conds.length) this.stopped = true;
    else this.ends.push(conds);
  }

  // One end URL; when ends redirect differently, an expression picks the URL of the path taken.
  endUrl() {
    const o = this.options;
    const fallback = o.SurveyTermination === 'Redirect' && /^https?:\/\/./.test(o.EOSRedirectURL || '') ? o.EOSRedirectURL : '';
    const rs = this.redirects;
    if (!rs.length) { this.redirect = fallback; return; }
    if (rs.length === 1 && !rs[0].conds.length) { this.redirect = rs[0].url; return; }
    let expr = JSON.stringify(fallback);
    for (const r of [...rs].reverse()) expr = r.conds.length ? `if(${and(r.conds.map(c => this.cond(c)))}, ${JSON.stringify(r.url)}, ${expr})` : JSON.stringify(r.url);
    this.redirect = `{${expr}}`;
  }

  embedded(ed, conds) {
    const field = ed.Field || ed.Description;
    if (!field || /^Create New Field/.test(field)) return;
    const v = this.varName(field);
    const value = ed.Value;
    const tok = recipient(field);
    if (tok && ed.Type !== 'Custom') return this.assign(v, tok, conds);
    const meta = { ResponseID: 'SAVEDID', SurveyID: 'SID', StartDate: 'date("Y-m-d H:i:s")', RecordedDate: 'date("Y-m-d H:i:s")', CurrentDate: 'date("Y-m-d")', CurrentTime: 'date("H:i:s")', Q_Language: 'LANG', UserLanguage: 'LANG' }[field];
    if (meta && ed.Type !== 'Custom') return this.assign(v, meta, conds);
    if (ed.Type === 'SurveyMetaData' || ed.Type === 'Survey') {
      if (this.problem(`Embedded data "${field}"`, `The built-in Qualtrics field "${field}" has no LimeSurvey equivalent.`, 'Remove it from the flow, or set it with a URL parameter of the same name.',
        [opt('url', 'Fill it from the survey link', `The value comes from the link, for example ...?${field}=value. Without it, the field stays empty.`), opt('empty', 'Leave it empty', 'The field exists in the data but stays empty.')],
        { qualtrics: `Qualtrics fills "${field}" by itself with information about the survey or the response.`, why: 'LimeSurvey does not know this value, so you decide where it should come from.' }) === 'url') this.vars[field].urlParam = true;
      return;
    }
    if (ed.Type === 'Recipient' || value === undefined || value === null || value === '') {
      this.vars[field].urlParam = true; // filled from the survey link (?field=...)
      return;
    }
    this.assign(v, { raw: String(value), where: `Embedded data "${field}"` }, conds);
  }

  varName(field) {
    if (!this.vars[field]) {
      const q = this.newQuestion(this.varGroup, field, 'S', { where: `Embedded data "${field}"` });
      q.hidden = true;
      q.text = { [this.lang]: field };
      this.vars[field] = q;
    }
    return this.vars[field].code;
  }

  // Puts `{var = value}` in an all-hidden group at this point of the flow.
  assign(code, value, conds) {
    let g = this.groups[this.groups.length - 1];
    if (!g.setGroup || g.conds !== conds) {
      g = this.newGroup('Set variables', conds, '');
      g.setGroup = true;
    }
    const q = this.newQuestion(g, `set${code}`, '*', { where: `Hidden field "${code}"` });
    q.hidden = true;
    q.assign = { code, value };
  }

  // ---------- blocks and pages ----------

  addBlock(id, conds, rgroup) {
    const b = this.blocks[id];
    if (!b) return this.problem(`Survey flow`, `Block ${id} is in the survey flow but missing from the file.`, 'Export the survey again from Qualtrics.');
    if (b.Type === 'Trash') return;
    if (b.groups) {
      // A block shown again later in the flow: LimeSurvey shows a group once, so either occurrence shows it.
      for (const g of b.groups) g.alt.push(conds);
      return this.note(`Block "${b.Description}"`, 'This block is used twice in the survey flow. LimeSurvey shows it once, at the first place it appears.', 'If respondents must see it twice, copy the question group in LimeSurvey.');
    }
    b.groups = [];
    const iterations = this.loopIterations(b);
    const opts = b.Options || {};
    const loopRg = iterations.length > 1 && opts.LoopingOptions && /random/i.test(String(opts.LoopingOptions.Randomization)) && opts.LoopingOptions.Randomization !== 'None' ? `rg${this.nextId++}` : '';
    for (const it of iterations) {
      const pages = [[]];
      for (const el of b.BlockElements || []) {
        if (el.Type === 'Page Break') pages.push([]);
        else if (el.Type === 'Question') pages[pages.length - 1].push(el);
      }
      const blockQs = [];
      pages.filter(p => p.length).forEach((page, pi, all) => {
        const name = strip(b.Description || 'Block') + (it ? ` (${it.label})` : '') + (all.length > 1 ? ` - page ${pi + 1}` : '');
        const g = this.newGroup(name, it && it.cond ? [...conds, it.cond] : conds, loopRg || rgroup);
        b.groups.push(g);
        for (const el of page) {
          const q = this.addQuestion(el.QuestionID, g, it);
          if (q) blockQs.push({ q, el });
        }
        if (randomQuestions(opts)) for (const q of g.questions) q.attrs.random_group = `rq${g.gid}`;
      });
      this.skipLogic(blockQs);
    }
    if (opts.RandomizeQuestions && !['false', 'true', 'All', false, true].includes(opts.RandomizeQuestions)) {
      const c = this.problem(`Block "${b.Description}"`, 'This block shows only some of its questions, or mixes them in a special way.', 'Set the block to randomize all questions, or remove the randomization.',
        [opt('all', 'Shuffle all questions', 'Every respondent sees all questions of the block, in a random order.'), opt('none', 'Keep the original order', 'Every respondent sees all questions of the block, in the original order.')],
        { qualtrics: 'Qualtrics picks a random selection of questions from this block (or uses an advanced randomization) for each respondent.', why: 'LimeSurvey can shuffle a whole page, but not pick a subset of its questions.' });
      if (c === 'all') for (const g of b.groups) for (const q of g.questions) q.attrs.random_group = `rq${g.gid}`;
    }
  }

  loopIterations(b) {
    const o = b.Options || {};
    if (!o.Looping || o.Looping === 'None') return [null];
    const lo = o.LoopingOptions || {};
    const st = lo.Static || {};
    const keys = Object.keys(st);
    if (o.Looping === 'Static') return keys.map((k, i) => ({ key: k, n: i + 1, label: `loop ${i + 1}`, fields: st[k] }));
    const loc = lo.ChoiceGroupLocator || lo.Locator || '';
    const m = /^q:\/\/(QID\d+)\/(.*)$/.exec(loc.split('?')[0]);
    if (o.Looping === 'Question' && m) {
      const src = this.questions[m[1]];
      if (/LoopAndMerge\/MergeOnNumericResponse/.test(m[2])) {
        return keys.map((k, i) => ({ key: k, n: i + 1, label: `loop ${i + 1}`, fields: st[k], cond: { logic: numericLoop(m[1], i + 1), where: `Block "${b.Description}": when a loop round is shown` } }));
      }
      if (src) {
        const what = m[2].replace('ChoiceGroup/', '');
        const ids = order(src.ChoiceOrder, src.Choices);
        return ids.map((id, i) => {
          const op = { SelectedChoices: 'Selected', UnselectedChoices: 'NotSelected', DisplayedChoices: 'Displayed', NotDisplayedChoices: 'NotDisplayed' }[what];
          return {
            key: id, n: i + 1, label: strip(display(src.Choices[id])) || `loop ${i + 1}`,
            fields: { 1: display(src.Choices[id]), ...(st[id] || {}) },
            cond: op ? { logic: choiceLogic(m[1], id, op), where: `Block "${b.Description}": when a loop round is shown` } : null,
          };
        });
      }
    }
    this.problem(`Block "${b.Description}"`, 'This block repeats (loop & merge) in a way that could not be read.', 'Use a static loop, or a loop over the choices of one question.',
      [opt('once', 'Show it once, without repeating', 'Respondents answer the block one time instead of once per loop.')],
      { qualtrics: 'Qualtrics repeats this block several times, for example once per selected choice.', why: 'The loop settings in the file could not be understood, so the repeats cannot be built.' });
    return [null];
  }

  skipLogic(blockQs) {
    blockQs.forEach(({ q, el }, i) => {
      const skips = el.SkipLogic || q.p.SkipLogic || [];
      for (const s of values(skips)) {
        const cond = { logic: { 0: { 0: { LogicType: 'Question', QuestionID: s.QuestionID, Operator: s.Condition, LeftOperand: s.Locator || s.ChoiceLocator, ChoiceLocator: s.ChoiceLocator, RightOperand: s.RightOperand, Type: 'Expression' }, Type: 'If' }, Type: 'BooleanExpression' }, where: `Question "${q.code}": skip`, iter: q.iter };
        const dest = s.SkipToDestination;
        let later = blockQs.slice(i + 1);
        if (/^QID/.test(dest)) {
          const j = later.findIndex(x => x.q.qsfId === dest);
          if (j < 0) { this.problem(`Question "${q.code}": skip`, 'This skip jumps to a question that is not further down in the same block.', 'Point the skip at a later question of the same block, or use display logic.', [opt('ignore', 'Leave the skip out', 'Nobody skips; all respondents see the questions that would have been skipped.')], { qualtrics: 'After this question, Qualtrics jumps straight to another question when the condition is met.', why: 'LimeSurvey can only hide the questions in between, and here there is no clear "in between".' }); continue; }
          later = later.slice(0, j);
        } else if (dest === 'ENDOFSURVEY') {
          this.ends.push([cond]);
        } else if (dest !== 'ENDOFBLOCK') {
          this.problem(`Question "${q.code}": skip`, `This skip jumps to "${dest}", which is not a place this converter knows.`, 'Use End of block, End of survey or a later question.', [opt('ignore', 'Leave the skip out', 'Nobody skips; all respondents see the questions that would have been skipped.')], { qualtrics: 'After this question, Qualtrics jumps somewhere else when the condition is met.', why: 'The destination of the jump could not be understood.' });
          continue;
        }
        for (const x of later) x.q.notIf.push(cond);
      }
    });
  }

  newGroup(name, conds, rgroup) {
    const g = { gid: this.nextId++, name, conds, alt: [], ends: this.ends.slice(), rgroup, questions: [] };
    this.groups.push(g);
    return g;
  }

  newQuestion(g, base, type, extra = {}) {
    const q = { qid: this.nextId++, gid: g.gid, code: this.uniqueCode(base), type, text: {}, help: {}, attrs: {}, sub: [], sub2: [], answers: [], notIf: [], defaults: [], mandatory: 'N', other: 'N', preg: '', ...extra };
    g.questions.push(q);
    return q;
  }

  uniqueCode(base) {
    let c = String(base).replace(/[^A-Za-z0-9]/g, '');
    if (!/^[A-Za-z]/.test(c)) c = 'Q' + c;
    c = c.slice(0, 16);
    if (['LANG', 'SID', 'SAVEDID', 'TOKEN', 'QID', 'GID', 'SGQ', 'self', 'that', 'this'].includes(c)) c += 'x';
    let out = c;
    for (let i = 2; this.codes.has(out.toLowerCase()); i++) out = c + i;
    this.codes.add(out.toLowerCase());
    return out;
  }

  // ---------- questions ----------

  addQuestion(qid, g, it) {
    let p = this.questions[qid];
    if (!p) { this.problem(`Question ${qid}`, 'Question is listed in a block but missing from the file.', 'Export the survey again from Qualtrics.'); return null; }
    const where = `Question "${p.DataExportTag || qid}"`;
    const edit = this.edits[qid] || {};
    if (!this.items.some(x => x.id === qid)) {
      this.items.push({ id: qid, code: p.DataExportTag || qid, type: TYPE_NAMES[p.QuestionType] || p.QuestionType, text: strip(p.QuestionText || '').slice(0, 140), block: strip(g.name), mandatory: forced((p.Validation || {}).Settings || {}), skip: !!edit.skip, newCode: edit.code || '', newMandatory: edit.mandatory || '' });
    }
    if (edit.skip) { this.note(where, 'Left out, as you chose on the Questions tab.'); return null; }
    const base = (String(edit.code || '').trim() || p.DataExportTag || qid) + (it ? `L${it.n}` : '');
    const ctx = { p, where, iter: it, qsfId: qid };
    if (p.QuestionType === 'Timing') {
      this.savetimings = true;
      const max = Number((p.Configuration || {}).MaxSeconds) || 0;
      if (max > 0) { g.timeLimit = max; this.note(where, `The timer question itself is gone. LimeSurvey moves on to the next page after ${max} seconds, and records how long each respondent spent on every page.`); }
      else this.note(where, 'The timer question itself is gone. LimeSurvey records how long each respondent spent on every page instead.');
      return null;
    }
    if (p.QuestionType === 'Meta') { this.note(where, 'The question that recorded browser and device details is gone.', 'To keep the IP address and the page respondents came from, switch on "Save IP address" and "Save referrer URL" in LimeSurvey (Settings, Notifications & data).'); return null; }
    if (p.QuestionType === 'Captcha') { this.captcha = true; this.note(where, 'The captcha question is gone. LimeSurvey shows its own captcha at the start of the survey instead.'); return null; }
    if (p.QuestionType in UNSUPPORTED) {
      const upload = ['SS', 'Draw', 'ScreenCapture', 'Video'].includes(p.QuestionType);
      const kind = TYPE_NAMES[p.QuestionType] || p.QuestionType;
      const c = this.problem(where, `LimeSurvey has no "${kind}" question.`, UNSUPPORTED[p.QuestionType], [
        ...(upload ? [opt('upload', 'Replace with a file upload', 'Respondents upload a file (for example a photo or a scan) instead.')] : []),
        opt('text', 'Replace with a long text box', 'Respondents type their answer in words instead.'),
        opt('display', 'Show only the question text', 'Respondents read the text but cannot answer it; no data is collected.'),
        opt('remove', 'Leave the question out', 'The question disappears, with its data. Logic that uses it will ask you again.'),
      ], { qualtrics: `Qualtrics shows a special "${kind}" question here.`, why: 'LimeSurvey has no question that works the same way, so pick the closest replacement.' });
      const as = { upload: { QuestionType: 'FileUpload' }, text: { QuestionType: 'TE', Selector: 'ML' }, display: { QuestionType: 'DB' } }[c];
      if (!as) return null;
      p = ctx.p = { ...p, ...as, Validation: as.QuestionType === 'DB' ? undefined : p.Validation };
    }
    if (p.QuestionJS && !isDefaultJs(p.QuestionJS)) {
      const c = this.problem(where, 'This question has custom JavaScript that only works in Qualtrics.', 'Remove the JavaScript in Qualtrics, then rebuild the behaviour in LimeSurvey with ExpressionScript or the question\'s own script field.',
        [opt('drop', 'Keep the question, drop the script', 'The question is asked normally, without the extra behaviour the script added (such as timers, hidden buttons or custom layouts).'), opt('remove', 'Leave the question out', 'The question disappears, with its data.')],
        { qualtrics: 'Qualtrics runs a small program with this question, for example to hide the Next button, time the answer or change the layout.', why: 'The program uses Qualtrics commands that do not exist in LimeSurvey, so it would not run.' });

      if (c === 'remove') return null;
    }
    if (p.QuestionType === 'SBS') return this.sideBySide(p, g, ctx, base);
    const q = this.newQuestion(g, base, 'X', ctx);
    this.models[qid + (it ? '#' + it.key : '')] = q;
    if (it && !this.models[qid]) this.models[qid] = q;
    q.rawText = p.QuestionText || '';
    this.mapType(q, p);
    this.validation(q, p);
    this.randomization(q, p);
    if (['Y', 'S', 'N'].includes(edit.mandatory) && !['X', '*'].includes(q.type)) q.mandatory = edit.mandatory;
    this.defaults(q, p);
    if (p.ChoiceGroups && Object.keys(p.ChoiceGroups).length) this.note(where, 'The headings that grouped the choices are not shown. All choices are kept, in the same order.');
    if (p.Labels && Object.keys(p.Labels).length && q.type === 'K') this.note(where, 'The labels along the slider scale are not shown.', 'Put them in the question text, or write "left label|right label" as the slider item text to show a label at each end.');
    if (p.Configuration && p.Configuration.NotApplicable) this.note(where, 'The "Not applicable" box next to the slider is not available.', 'If you need it, add a separate yes/no question in LimeSurvey.');
    this.scoring(q, p);
    return q;
  }

  sideBySide(p, g, ctx, base) {
    const cols = Object.entries(p.AdditionalQuestions || {});
    this.note(ctx.where, `This side-by-side question became ${cols.length} grid questions shown one after another, one per column, with the same rows. Answers are stored per column.`);
    let first;
    cols.forEach(([k, sub], i) => {
      const q = this.newQuestion(g, `${base}c${k}`, 'X', { ...ctx, where: `${ctx.where} column ${k}` });
      if (!first) first = q;
      const sp = { ...sub, Choices: sub.Choices || p.Choices, ChoiceOrder: sub.ChoiceOrder || p.ChoiceOrder, DisplayLogic: p.DisplayLogic, Language: {} };
      q.p = sp;
      q.rawText = (i === 0 ? (p.QuestionText || '') + '<br>' : '') + `<strong>${sub.QuestionText || ''}</strong>`;
      this.mapType(q, sp);
      this.validation(q, sp);
      this.models[`${p.QuestionID}#col${k}`] = q;
    });
    if (first) this.models[p.QuestionID + (ctx.iter ? '#' + ctx.iter.key : '')] = first;
    return first;
  }

  mapType(q, p) {
    const sel = p.Selector, sub = p.SubSelector;
    const t = p.QuestionType;
    if (t === 'DB') { q.type = 'X'; return; }
    if (t === 'MC') {
      if (sel === 'NPS') { q.type = 'L'; q.attrs.display_columns = 11; return this.choicesAsAnswers(q, p); }
      if (['SAVR', 'SAHR', 'SACOL', 'DL', 'SB'].includes(sel)) {
        q.type = ['DL', 'SB'].includes(sel) ? '!' : 'L';
        if (sel === 'SAHR') q.attrs.display_columns = order(p.ChoiceOrder, p.Choices).length;
        if (sel === 'SACOL') q.attrs.display_columns = (p.Configuration || {}).NumColumns || 2;
        return this.choicesAsAnswers(q, p);
      }
      if (['MAVR', 'MAHR', 'MACOL', 'MSB'].includes(sel)) {
        q.type = 'M';
        if (sel === 'MAHR') q.attrs.display_columns = order(p.ChoiceOrder, p.Choices).length;
        if (sel === 'MACOL') q.attrs.display_columns = (p.Configuration || {}).NumColumns || 2;
        if (sel === 'MSB') this.note(q.where, 'The multi-select box is shown as a list of checkboxes. Answers are stored the same way.');
        return this.choicesAsSub(q, p);
      }
    }
    if (t === 'Matrix') {
      if (['Likert', 'Bipolar', 'Carousel'].includes(sel) || (sel === 'Likert' && sub)) {
        if (sub === 'MultipleAnswer') { q.type = ':'; q.attrs.multiflexible_checkbox = 1; }
        else {
          q.type = 'F';
          if (sub === 'DL') q.attrs.use_dropdown = 1;
          if (sub === 'DND' || sel === 'Carousel') this.note(q.where, `The ${sel === 'Carousel' ? 'carousel' : 'drag-and-drop'} layout is shown as a regular grid. Answers are stored the same way.`);
        }
        this.choicesAsSub(q, p, sel === 'Bipolar');
        this.answersAsColumns(q, p);
        return;
      }
      if (sel === 'TE') { q.type = ';'; this.choicesAsSub(q, p); this.answersAsSub2(q, p); return; }
      if (sel === 'CS') {
        q.type = ':'; q.attrs.input_boxes = 1; this.choicesAsSub(q, p); this.answersAsSub2(q, p);
        this.note(q.where, 'This grid of numbers no longer checks that the numbers add up to the required total.', 'If the total matters, add a check in LimeSurvey (question settings, Logic, Question validation equation).');
        return;
      }
    }
    if (t === 'TE') {
      const ct = ((p.Validation || {}).Settings || {}).ContentType;
      if (sel === 'FORM') { q.type = 'Q'; this.choicesAsSub(q, p); return; }
      if (sel === 'ML') { q.type = 'T'; return; }
      if (sel === 'ESTB') { q.type = 'U'; return; }
      if (sel === 'PW') this.note(q.where, 'The password box is a normal text box, so respondents see what they type.');
      if (ct === 'ValidNumber') { q.type = 'N'; return; }
      if (ct === 'ValidDate') { q.type = 'D'; q.attrs.date_format = 'mm/dd/yyyy'; return; }
      q.type = 'S';
      return;
    }
    if (t === 'Slider' || t === 'CS') {
      const c = p.Configuration || {};
      q.type = 'K';
      this.choicesAsSub(q, p);
      if (t === 'Slider' || /SLIDER|bar|HBAR/i.test(sel)) {
        q.attrs.slider_layout = 1;
        q.attrs.slider_min = c.CSSliderMin ?? 0;
        q.attrs.slider_max = c.CSSliderMax ?? 100;
        q.attrs.slider_accuracy = c.SnapToGrid && c.GridLines ? (q.attrs.slider_max - q.attrs.slider_min) / c.GridLines : 1 / Math.pow(10, Number(c.NumDecimals) || 0);
        q.attrs.slider_showminmax = 1;
        if (sel === 'STAR') this.note(q.where, 'The star rating is shown as a slider with the same range.');
      }
      if (t === 'CS') {
        const s = (p.Validation || {}).Settings || {};
        const total = s.ChoiceTotal ?? s.ChoicesTotal ?? c.ChoiceTotal;
        if (total !== undefined && total !== '') q.attrs.equals_num_value = total;
      }
      return;
    }
    if (t === 'RO') {
      q.type = 'R';
      if (sel !== 'DND') this.note(q.where, 'Respondents rank the choices by dragging them, the LimeSurvey way. Answers are stored the same way.');
      return this.choicesAsAnswers(q, p);
    }
    if (t === 'HotSpot') {
      this.note(q.where, 'Respondents no longer click on the image. They pick the image areas from a list instead.', 'If respondents need to see the image, add it to the question text in LimeSurvey.');
      if (sel === 'LikeDislike') {
        q.type = 'F'; this.choicesAsSub(q, p);
        q.answers.push({ code: '1', raw: 'Like', id: 'like', scale: 0, kind: 'Answers' }, { code: '2', raw: 'Dislike', id: 'dislike', scale: 0, kind: 'Answers' });
        q.answerCode = { 1: '1', 2: '2' };
        return;
      }
      q.type = 'M'; return this.choicesAsSub(q, p);
    }
    if (t === 'HL') {
      q.type = 'F'; this.choicesAsSub(q, p); this.answersAsColumns(q, p);
      this.note(q.where, 'Respondents no longer highlight words in a text. Each word is a row in a grid, and they pick one of your categories for it.');
      if (!q.answers.length && this.problem(q.where, 'The categories of this highlight question could not be read.', 'Replace it with a matrix question.', [opt('text', 'Replace with a long text box', 'Respondents type their answer in words instead.')], { qualtrics: 'Respondents highlight words in a text and give each a category.', why: 'Without the categories there is nothing to convert it to.' }) === 'text') { q.type = 'T'; q.sub = []; }
      return;
    }
    if (t === 'Matrix' && sel === 'MaxDiff') {
      // Array by column: each column (most / least) picks one item.
      q.type = 'H';
      this.answersAsSub(q, p);
      this.choicesAsAnswers(q, p);
      if (q.sub.length === 2) {
        const [a, b] = q.sub.map(x => `${q.code}_${x.code}.NAOK`);
        q.attrs.em_validation_q = `is_empty(${a}) or ${a} != ${b}`;
        q.attrs.em_validation_q_tip = 'Pick a different item in each column.';
      }
      this.note(q.where, 'Shown as a grid with two columns, such as "most" and "least". Respondents pick one item in each column and cannot pick the same item twice.', 'If your design shows several MaxDiff sets, copy this question in LimeSurvey once per set.');
      return;
    }
    if (t === 'FileUpload') { q.type = '|'; q.attrs.max_num_of_files = 1; return; }
    const c = this.problem(q.where, `This "${TYPE_NAMES[t] || t}" question uses a layout (${sel}${sub ? '/' + sub : ''}) that LimeSurvey does not have.`, 'Change it to a standard type (multiple choice, matrix, text entry, slider, rank order) in Qualtrics.',
      [opt('text', 'Replace with a long text box', 'Respondents type their answer in words instead.'), opt('display', 'Show only the question text', 'Respondents read the text but cannot answer it; no data is collected.')],
      { qualtrics: 'Qualtrics shows this question with a special layout.', why: 'The converter does not know a LimeSurvey question that works the same way.' });
    if (c) q.type = c === 'text' ? 'T' : 'X';
  }

  // Choices of a single-answer or ranking question become answer options.
  choicesAsAnswers(q, p) {
    q.choiceCode = {};
    const ids = order(p.ChoiceOrder, p.Choices);
    const text = ids.filter(id => p.Choices[id] && p.Choices[id].TextEntry && p.Choices[id].TextEntry !== 'false');
    const used = new Set();
    for (const id of ids) {
      const c = p.Choices[id];
      if (!c) continue;
      if (text[0] === id && q.type !== 'R') {
        q.other = 'Y';
        q.otherId = id;
        q.choiceCode[id] = '-oth-';
        q.otherText = { raw: display(c), id };
        continue;
      }
      const code = answerCode(recode(p, id), id, used);
      q.choiceCode[id] = code;
      q.answers.push({ code, raw: display(c), id, scale: 0, kind: 'Choices' });
      if (text.includes(id) && q.type !== 'R') this.textBox(q, id, c);
    }
    const logic = q.answers.filter(a => p.Choices[a.id].DisplayLogic);
    if (logic.length && q.type !== 'R') this.choiceFilter(q, p);
    else if (logic.length) this.problem(q.where, 'Some choices of this ranking question appear only under a condition.', 'Remove the choice display logic, or carry the choices forward from a multiple choice question.', [opt('all', 'Always show all choices', 'Every respondent ranks all choices, including ones they would not have seen.')], { qualtrics: 'Qualtrics hides some choices from the ranking unless a condition is met.', why: 'LimeSurvey cannot hide single choices in a ranking question.' });
    if (q.otherId && p.Choices[q.otherId].DisplayLogic) this.problem(q.where, `The choice "${strip(display(p.Choices[q.otherId]))}" (with a text box) appears only under a condition.`, 'Remove the display logic from that choice.', [opt('always', 'Always show it', 'Every respondent sees this choice and its text box.')], { qualtrics: 'Qualtrics shows this "other, please specify" choice only when a condition is met.', why: 'LimeSurvey always shows its "Other" choice; it cannot be hidden by a condition.' });
    if (q.other === 'Y' && text[0] !== ids[ids.length - 1]) q.attrs.other_position = 'end';
    this.carryForward(q, p, true);
  }

  // Choices become subquestions (multiple choice rows, matrix statements, slider items, form fields).
  choicesAsSub(q, p, bipolar = false) {
    q.choiceCode = {};
    const ids = order(p.ChoiceOrder, p.Choices);
    const used = new Set();
    const exclusive = [];
    for (const id of ids) {
      const c = p.Choices[id];
      if (!c) continue;
      if (q.type === 'M' && c.TextEntry && c.TextEntry !== 'false' && q.other !== 'Y') {
        q.other = 'Y'; q.otherId = id; q.choiceCode[id] = 'other'; q.otherText = { raw: display(c), id };
        if (id !== ids[ids.length - 1]) q.attrs.other_position = 'end';
        continue;
      }
      const code = subCode(recode(p, id), id, used);
      if (c.TextEntry && c.TextEntry !== 'false' && q.type !== 'Q') this.textBox(q, id, c);
      q.choiceCode[id] = code;
      let raw = display(c);
      if (bipolar && raw.includes(':')) raw = raw.replace(':', '|');
      q.sub.push({ code, raw, id, logic: c.DisplayLogic, kind: 'Choices' });
      if (c.ExclusiveAnswer) exclusive.push(code);
    }
    if (exclusive.length) q.attrs.exclude_all_others = exclusive.join(';');
    this.carryForward(q, p, false);
  }

  // LimeSurvey cannot hide single answer options directly. A hidden multiple choice question filters them
  // (array_filter). An equation ticks the options whose display logic is true; it sits in an all-hidden group
  // just before the question's page, because Qualtrics also evaluates choice logic when the page loads.
  choiceFilter(q, p) {
    const qg = this.groups.find(x => x.gid === q.gid);
    const g = this.newGroup('Set choice filter', qg.conds, '');
    g.ends = qg.ends;
    g.alt = qg.alt;
    this.groups.splice(this.groups.indexOf(g), 1);
    this.groups.splice(this.groups.indexOf(qg), 0, g);
    g.filterFor = qg;
    this.newQuestion(g, `${q.code}filterset`, '*', { where: q.where, hidden: true, filterOf: q });
    const h = this.newQuestion(g, `${q.code}filter`, 'M', { where: q.where, p: {}, rawText: '', hidden: true });
    for (const a of q.answers) h.sub.push({ code: a.code, raw: a.raw, id: a.id, kind: 'Choices', filterLogic: p.Choices[a.id].DisplayLogic });
    q.filter = h;
    q.attrs.array_filter = h.code;
  }

  // A text box on a choice that LimeSurvey cannot attach: a short text question right after this one.
  textBox(q, id, c) {
    const g = this.groups.find(x => x.gid === q.gid);
    const t = this.newQuestion(g, `${q.code}${id}TEXT`, 'S', { where: q.where, followOf: q, followId: id, followRaw: display(c) });
    (q.textBoxes || (q.textBoxes = {}))[id] = t;
    this.note(q.where, `The text box next to "${strip(display(c))}" became its own small question (${t.code}), shown right after it when that choice is picked. The typed text is stored under ${t.code}.`);
  }

  answersAsColumns(q, p) {
    q.answerCode = {};
    const used = new Set();
    for (const id of order(p.AnswerOrder, p.Answers)) {
      const a = p.Answers[id];
      if (!a) continue;
      const code = answerCode(recode(p, id), id, used);
      q.answerCode[id] = code;
      q.answers.push({ code, raw: display(a), id, scale: 0, kind: 'Answers' });
    }
  }

  answersAsSub(q, p) {
    q.answerCode = {};
    const used = new Set();
    for (const id of order(p.AnswerOrder, p.Answers)) {
      const a = p.Answers[id];
      if (!a) continue;
      const code = subCode(recode(p, id), id, used);
      q.answerCode[id] = code;
      q.sub.push({ code, raw: display(a), id, kind: 'Answers' });
    }
  }

  answersAsSub2(q, p) {
    q.answerCode = {};
    const used = new Set();
    for (const id of order(p.AnswerOrder, p.Answers)) {
      const a = p.Answers[id];
      if (!a) continue;
      const code = subCode(recode(p, id), id, used);
      q.answerCode[id] = code;
      q.sub2.push({ code, raw: display(a), id, kind: 'Answers' });
    }
  }

  carryForward(q, p, isList) {
    const dc = p.DynamicChoices;
    if (!dc || !dc.Locator) return;
    const m = /^q:\/\/(QID\d+)\/ChoiceGroup\/(\w+)/.exec(dc.Locator);
    const src = m && this.questions[m[1]];
    if (!src) return this.problem(q.where, 'This question takes its choices from another question, but that question could not be found.', 'Type the choices into the question instead of carrying them forward.', [opt('own', 'Use only its own choices', 'Respondents see only the choices typed into this question itself.')], { qualtrics: 'Qualtrics copies choices from an earlier question into this one (carry forward).', why: 'The earlier question is missing from the file, so there is nothing to copy.' });
    q.carry = { from: m[1], what: m[2], isList };
    // Carried choices keep the source's choice IDs, prefixed with "x" in Qualtrics, and its codes (needed by array_filter).
    const srcCodes = (this.models[m[1]] || {}).choiceCode || {};
    const list = isList ? q.answers : q.sub;
    const used = new Set(list.map(x => x.code.toLowerCase()));
    for (const id of order(src.ChoiceOrder, src.Choices)) {
      let code = srcCodes[id];
      if (!code || used.has(code.toLowerCase()) || /^(other|-oth-)$/.test(code)) code = (isList ? answerCode : subCode)(recode(src, id), id, used);
      used.add(code.toLowerCase());
      q.choiceCode['x' + id] = code;
      list.push({ code, raw: display(src.Choices[id]), id: 'x' + id, scale: 0, carried: id, kind: 'Choices' });
    }
  }

  defaults(q, p) {
    const d = p.DefaultChoices;
    if (!d || typeof d !== 'object' || !Object.keys(d).length) return;
    const on = v => v === true || (v && (v.Selected === true || v.Selected === 'true'));
    let done = true;
    for (const [id, v] of Object.entries(d)) {
      if (id === 'TEXT' && ['S', 'T', 'U', 'N'].includes(q.type)) { q.defaults.push({ value: (v && v.Text) || '' }); continue; }
      const code = (q.choiceCode || {})[id];
      if (['L', '!'].includes(q.type) && code && on(v)) q.defaults.push({ value: code });
      else if (q.type === 'M' && code && on(v)) q.defaults.push({ sub: q.sub.find(s => s.code === code), value: 'Y' });
      else if (q.type === 'F' && code && v && typeof v === 'object') {
        const col = Object.keys(v).find(k => on(v[k]));
        if (col && q.answerCode[col]) q.defaults.push({ sub: q.sub.find(s => s.code === code), value: q.answerCode[col] });
      } else if (q.type === 'Q' && code && v && v.Text !== undefined) q.defaults.push({ sub: q.sub.find(s => s.code === code), value: v.Text });
      else done = false;
    }
    if (!done) this.note(q.where, 'Some pre-filled answers could not be carried over.', 'Check the question\'s "Default answers" in LimeSurvey.');
  }

  validation(q, p) {
    const s = (p.Validation || {}).Settings || {};
    q.mandatory = forced(s);
    if (q.type === 'X' || q.type === '*') q.mandatory = 'N';
    const type = s.Type;
    if (!type || type === 'None') return;
    if (type === 'MinChoices' || type === 'RangeOfChoices' || type === 'MaxChoices' || type === 'ExactChoices') {
      const min = s.MinChoices ?? (type === 'ExactChoices' ? s.ExactChoices ?? s.MaxChoices : undefined);
      const max = s.MaxChoices ?? (type === 'ExactChoices' ? s.ExactChoices ?? s.MinChoices : undefined);
      if (min) q.attrs.min_answers = min;
      if (max) q.attrs.max_answers = max;
      return;
    }
    if (type === 'ContentType') {
      const ct = s.ContentType;
      if (ct === 'ValidNumber') {
        const v = s.ValidNumber || {};
        if (q.type === 'N') {
          if (v.Min !== undefined && v.Min !== '') q.attrs.min_num_value_n = v.Min;
          if (v.Max !== undefined && v.Max !== '') q.attrs.max_num_value_n = v.Max;
          if (String(v.NumDecimals) === '0') q.attrs.num_value_int_only = 1;
        } else q.attrs.numbers_only = 1;
        return;
      }
      if (ct === 'ValidDate') return;
      const re = { ValidEmail: '/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/', ValidUSPhone: '/^\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}$/', ValidPhone: '/^[+0-9 ()./-]{6,}$/', ValidUSZip: '/^\\d{5}(-\\d{4})?$/', ValidZip: '/^[A-Za-z0-9 -]{3,10}$/', ValidTextOnly: '/^[^0-9]*$/', ValidUSState: '/^[A-Za-z]{2}$/' }[ct];
      if (re) { q.preg = re; return; }
      return this.problem(q.where, 'This text box checks the answer format in a way LimeSurvey does not know.', 'Use email, number, phone, zip, date or text-only validation, or write a regular expression in LimeSurvey.', [opt('drop', 'Accept any text', 'Respondents can type anything; you may get answers in the wrong format.')], { qualtrics: `Qualtrics only accepts answers in the format "${ct}".`, why: 'LimeSurvey has no ready-made check for this format.' });
    }
    if (type === 'MinChar' || type === 'MaxChar' || type === 'CharRange' || type === 'TextLength') {
      if (s.MaxChars) q.attrs.maximum_chars = s.MaxChars;
      if (s.MinChars) { q.attrs.em_validation_q = `is_empty(self.NAOK) or strlen(self.NAOK) >= ${Number(s.MinChars)}`; q.attrs.em_validation_q_tip = `Please enter at least ${Number(s.MinChars)} characters.`; }
      return;
    }
    if (type === 'CustomValidation') {
      q.customValidation = s.CustomValidation;
      return;
    }
    if (type === 'ChoicesTotal' || type === 'MustTotal') return;
    this.problem(q.where, 'This question checks the answer in a way LimeSurvey does not know.', 'Use force response, choice counts, content type or custom validation in Qualtrics.', [opt('drop', 'Leave the check out', 'Any answer is accepted.')], { qualtrics: `Qualtrics checks the answer with a "${type}" rule before respondents can continue.`, why: 'LimeSurvey has no equivalent check.' });
  }

  randomization(q, p) {
    const r = p.Randomization;
    if (!r || !r.Type || r.Type === 'None') return;
    const listType = ['L', '!', 'R'].includes(q.type);
    if (listType) q.attrs.answer_order = 'random';
    else if (q.type === 'M') q.attrs.subquestion_order = 'random';
    else q.attrs.random_order = 1;
    if (r.Type !== 'All') this.note(q.where, 'Qualtrics shuffled only some of the choices. LimeSurvey shuffles all of them, so choices you kept in place (such as "Other") move too.');
  }

  // ---------- expressions (second pass, all questions known) ----------

  finishQuestion(q) {
    if (q.finished) return;
    q.finished = true;
    if (q.assign) {
      const v = typeof q.assign.value === 'string' ? q.assign.value : this.valueExpr(q.assign.value.raw, { where: q.assign.value.where });
      q.text[this.lang] = `{${q.assign.code} = ${v}}`;
    }
    if (q.filterOf) {
      const f = q.filterOf, h = f.filter;
      q.text[this.lang] = h.sub.map(x => `{${h.code}_${x.code} = ${x.filterLogic ? `if(${this.logic({ logic: x.filterLogic, where: `Question "${f.code}", choice "${strip(x.raw)}": when it is shown`, iter: f.iter })}, "Y", "")` : '"Y"'}}`).join('');
      return;
    }
    if (q.followOf) {
      const f = q.followOf;
      q.text[this.lang] = this.pipe(f.choiceCode ? q.followRaw : '', { where: q.where, iter: f.iter });
      const sel = ['L', '!', 'M'].includes(f.type) ? this.selected(f, q.followId, q.where) : '';
      q.relevance = and([f.relevance, sel]);
    }
    if (q.p === undefined) return;
    const ctx = { where: q.where, iter: q.iter };
    q.text[this.lang] = this.pipe(q.rawText, ctx);
    for (const [ql, ll] of this.qLangs) {
      const t = ((q.p.Language || {})[ql] || {}).QuestionText;
      if (t) q.text[ll] = this.pipe(t, ctx);
    }
    for (const list of [q.sub, q.sub2, q.answers]) for (const x of list) x.text = this.texts(q, x, ctx);
    if (q.otherText) q.attrs.other_replace_text = this.texts(q, { ...q.otherText, kind: 'Choices' }, ctx);
    const rel = [];
    if (q.p.DisplayLogic) rel.push(this.logic({ logic: q.p.DisplayLogic, where: `Question "${q.code}": when it is shown`, iter: q.iter }));
    if (q.p.InPageDisplayLogic) rel.push(this.logic({ logic: q.p.InPageDisplayLogic, where: `Question "${q.code}": when it is shown`, iter: q.iter }));
    for (const c of q.notIf) rel.push(`!(${this.logic(c)})`);
    for (const s of q.sub) {
      const r = [];
      if (s.logic) r.push(this.logic({ logic: s.logic, where: `Question "${q.code}", choice "${strip(s.raw)}": when it is shown`, iter: q.iter }));
      if (s.carried) r.push(this.carryExpr(q, s.carried));
      s.relevance = and(r);
    }
    if (q.carry) {
      // Like Qualtrics, hide the question when no choices are carried forward.
      const any = (q.carry.isList ? q.answers : q.sub).filter(x => x.carried).map(x => this.carryExpr(q, x.carried));
      if (any.length && any.every(Boolean)) rel.push(any.length > 1 ? `(${any.join(' or ')})` : any[0]);
    }
    q.relevance = and(rel);
    if (q.carry && q.carry.isList) {
      const src = this.ref(q.carry.from, q.iter);
      if (src && src.type === 'M' && ['SelectedChoices', 'UnselectedChoices'].includes(q.carry.what)) {
        q.attrs[q.carry.what === 'SelectedChoices' ? 'array_filter' : 'array_filter_exclude'] = src.code;
      } else if (!['AllChoices', 'DisplayedChoices'].includes(q.carry.what)) {
        this.problem(q.where, `This question shows only some choices of ${src ? src.code : q.carry.from}, in a way LimeSurvey cannot repeat here.`, 'Carry forward from a multiple choice question, or change this question to multiple choice.', [opt('all', 'Show all choices', `Respondents see every choice of ${src ? src.code : q.carry.from}, not just the carried ones.`)], { qualtrics: 'Qualtrics copies only certain choices (for example the selected ones) from an earlier question into this one.', why: 'LimeSurvey can only filter choices like this when the earlier question is a multiple choice (tick boxes) question.' });
      }
    }
    if (q.customValidation) {
      const cv = q.customValidation;
      q.attrs.em_validation_q = this.logic({ logic: cv.Logic, where: `Question "${q.code}": answer check`, iter: q.iter });
      const msg = cv.Message || {};
      q.attrs.em_validation_q_tip = strip(msg.description || '') || 'Please check your answer.';
      if (msg.libraryID) this.note(q.where, 'The error message for this question\'s answer check is stored in the Qualtrics library, so only its short name came across.', 'Check the message in LimeSurvey (question settings, Logic, Question validation tip).');
    }
  }

  carryExpr(q, choiceId) {
    const what = q.carry.what;
    const op = { SelectedChoices: 'Selected', UnselectedChoices: 'NotSelected', DisplayedChoices: 'Displayed', NotDisplayedChoices: 'NotDisplayed', AllChoices: null }[what];
    if (op === undefined) { this.problem(q.where, 'This question copies choices from an earlier one in a way LimeSurvey cannot repeat.', 'Carry forward selected, unselected, displayed or all choices.', [opt('all', 'Show all choices', 'Respondents see every choice of the earlier question.')], { qualtrics: `Qualtrics copies the "${what}" choices of an earlier question into this one.`, why: 'LimeSurvey can only copy selected, not selected, shown or all choices.' }); return ''; }
    if (!op) return '';
    return this.logic({ logic: choiceLogic(q.carry.from, choiceId, op), where: `Question "${q.code}": choices copied from an earlier question`, iter: q.iter });
  }

  texts(q, x, ctx) {
    const out = { [this.lang]: this.pipe(x.raw, ctx) };
    for (const [ql, ll] of this.qLangs) {
      const tr = ((q.p.Language || {})[ql] || {})[x.kind];
      const id = x.carried || x.id;
      const t = tr && tr[id] && tr[id].Display;
      if (t) out[ll] = this.pipe(t, ctx);
    }
    return out;
  }

  finishGroup(g) {
    if (g.relevance !== undefined) return;
    g.relevance = '';
    const parts = [];
    const occ = [g.conds, ...g.alt].map(cs => and(cs.map(c => this.cond(c))));
    parts.push(occ.some(o => !o) ? '' : occ.length > 1 ? occ.map(o => `(${o})`).join(' or ') : occ[0]);
    for (const e of g.ends) parts.push(`!(${and(e.map(c => this.cond(c)))})`);
    g.relevance = and(parts);
  }

  cond(c) { return c.expr ? c.expr : this.logic(c); }

  // Qualtrics BooleanExpression -> ExpressionScript. AND binds tighter than OR, like in Qualtrics.
  logic(c) {
    const l = c.logic;
    if (!l || typeof l !== 'object') return '';
    const sets = numKeys(l).map(k => l[k]);
    const parts = sets.map(set => {
      const items = numKeys(set).map(k => set[k]);
      return { conj: set.Conjuction || set.Conjunction, text: joinConj(items.map(it => ({ conj: it.Conjuction || it.Conjunction, text: this.item(it, c) }))) };
    });
    return joinConj(parts) || '1';
  }

  item(it, c) {
    const where = c.where;
    const op = it.Operator;
    if (it.LogicType === 'EmbeddedField' || /^e:\/\//.test(it.LeftOperand || '')) {
      const field = String(it.LeftOperand || '').replace(/^e:\/\/Field\//, '');
      return compare(this.fieldRef(field, where) + '.NAOK', op, this.valueExpr(it.RightOperand ?? '', { where, iter: c.iter }), where, this);
    }
    if (it.LogicType === 'PanelData') {
      const tok = recipient(String(it.LeftOperand || '').replace(/^m:\/\//, ''));
      if (tok) return compare(tok, op, this.valueExpr(it.RightOperand ?? '', { where, iter: c.iter }), where, this);
    }
    if (it.LogicType === 'DeviceType') {
      const tag = JSON.stringify(String(it.LeftOperand || '').toLowerCase());
      const hit = `!is_empty(stristr(${this.deviceVar()}.NAOK, ${tag}))`;
      return /Not/.test(op) ? `!(${hit})` : hit;
    }
    if (it.LogicType === 'ScoringCategory' || /^gr:\/\//.test(it.LeftOperand || '')) {
      const id = String(it.LeftOperand || '').replace(/^gr:\/\//, '').split('/')[0];
      if (this.scores[id]) return compare(this.scoreExpr(id), op, this.valueExpr(it.RightOperand ?? '', { where, iter: c.iter }), where, this);
    }
    if (it.LogicType !== 'Question') {
      const what = { GeoIP: 'the respondent\'s location, looked up from their internet address', Panel: 'information from a Qualtrics contact list', Quota: 'whether a quota is full', ScoringCategory: 'a score', Classification: 'a Qualtrics classification' }[it.LogicType] || `"${it.LogicType}"`;
      return this.condProblem(where, `This condition depends on ${what}.`,
        { GeoIP: 'Remove the location condition, or ask for the location in a question.', Panel: 'Use participant (token) attributes and test them with TOKEN:ATTRIBUTE_1.', Quota: 'Remove quota conditions; recreate the quotas in LimeSurvey.', ScoringCategory: 'Use LimeSurvey assessments, or compute the score with an equation question.', Classification: 'Remove the condition.' }[it.LogicType] || 'Replace it with a condition on an answer or embedded data field.',
        { qualtrics: `Qualtrics checks ${what}${it.Description ? ` ("${strip(it.Description).trim()}")` : ''}.` });
    }
    const loc = parseLoc(it.LeftOperand || it.ChoiceLocator || '');
    if (!loc) return this.condProblem(where, 'This condition could not be read.', 'Rebuild the condition on a question answer.', { qualtrics: `Qualtrics checks: ${strip(it.Description || it.LeftOperand || 'a condition')}.` });
    const iter = it.QuestionIsInLoop === 'yes' || loc.iter ? (loc.iter ? { key: loc.iter } : c.iter) : null;
    const q = this.ref(loc.qid + (loc.col ? '#col' + loc.col : ''), iter, it.QuestionIsInLoop === 'yes' ? c.iter : null);
    if (!q) return this.condProblem(where, `This condition uses the answer to a question that is not in the survey (${(this.questions[loc.qid] || {}).DataExportTag || loc.qid}).`, 'Remove the condition or restore the question.', { qualtrics: 'Qualtrics checks the answer to a question that was deleted, moved to the trash, or left out on the Questions tab.', why: 'Without that question there is no answer to check.' });
    const right = () => this.valueExpr(it.RightOperand ?? '', { where, iter: c.iter });
    const path = loc.path;
    const id = loc.ids[0];
    if (path === 'QuestionDisplayed' || path === 'AnswerDisplayed' || ((op === 'Displayed' || op === 'NotDisplayed') && !id)) {
      const shown = this.displayed(q);
      return op === 'NotDisplayed' ? `!(${shown})` : shown;
    }
    if (path === 'SelectableChoice' || path === 'ChoiceDisplayed') {
      if (op === 'Displayed' || op === 'NotDisplayed' || path === 'ChoiceDisplayed') {
        const code = q.choiceCode && q.choiceCode[id];
        const sub = code && q.sub.find(s => s.code === code);
        const shown = and([this.displayed(q), sub && sub.relevance]) || '1';
        return op === 'NotDisplayed' ? `!(${shown})` : shown;
      }
      const sel = this.selected(q, id, where);
      if (op === 'Selected') return sel;
      if (op === 'NotSelected') return `!(${sel})`;
      return compare(this.choiceValue(q, id), op, right(), where, this);
    }
    if (path === 'SelectableAnswer') {
      // Matrix: SelectableAnswer/<choice>/<answer>
      let [row, col] = loc.ids;
      if (col === undefined) {
        // SelectableAnswer/<answer> without a row: the answer is selected in any row.
        const ac = q.answerCode && q.answerCode[row];
        if (!ac) return this.condProblem(where, `This condition uses an answer column of ${q.code} that does not exist.`, 'Rebuild the condition in LimeSurvey.', { qualtrics: `Qualtrics checks an answer in the grid question ${q.code}.` });
        const any = q.sub.map(s => (q.type === ':' ? `${q.code}_${s.code}_${ac}.NAOK == 1` : `${q.code}_${s.code}.NAOK == "${ac}"`)).join(' or ');
        return op === 'NotSelected' ? `!(${any})` : `(${any})`;
      }
      if (!(q.choiceCode || {})[row] && (q.choiceCode || {})[col]) [row, col] = [col, row];
      const rc = q.choiceCode && q.choiceCode[row];
      const ac = q.answerCode && q.answerCode[col];
      if (!rc || !ac) return this.condProblem(where, `This condition uses a row or column of ${q.code} that does not exist.`, 'Rebuild the condition in LimeSurvey.', { qualtrics: `Qualtrics checks an answer in the grid question ${q.code}.` });
      const sel = q.type === ':' ? `${q.code}_${rc}_${ac}.NAOK == 1` : `${q.code}_${rc}.NAOK == "${ac}"`;
      if (op === 'NotSelected') return `!(${sel})`;
      return sel;
    }
    if (path === 'ChoiceTextEntryValue' || path === 'ChoiceNumericEntryValue' || path === 'SelectedChoicesCount' || path === 'ChoiceGroup' || path === 'TotalSum') {
      const v = this.pathExpr(q, loc, where);
      return compare(v, op, right(), where, this);
    }
    return this.condProblem(where, `This condition checks something about ${q.code} that LimeSurvey cannot check.`, 'Rebuild the condition on a selected choice or an entered value.', { qualtrics: `Qualtrics checks "${path}" of question ${q.code}.` });
  }

  // "Is displayed": the question's own and its group's relevance, written out (relevanceStatus is not
  // reliable inside other relevance equations).
  displayed(q) {
    this.finishQuestion(q);
    const g = this.groups.find(x => x.gid === q.gid);
    this.finishGroup(g);
    return and([g.relevance, q.relevance]) || '1';
  }

  ref(qid, iter, fallbackIter) {
    for (const it of [iter, fallbackIter]) if (it && this.models[`${qid}#${it.key}`]) return this.models[`${qid}#${it.key}`];
    return this.models[qid];
  }

  selected(q, id, where) {
    const code = q.choiceCode && q.choiceCode[id];
    if (!code) return this.condProblem(where, `This condition uses a choice of ${q.code} that does not exist.`, 'Fix the condition in Qualtrics.', { qualtrics: `Qualtrics checks a choice of ${q.code} that has since been deleted.` });
    if (['L', '!'].includes(q.type)) return `${q.code}.NAOK == "${code}"`;
    if (q.type === 'M') return code === 'other' ? `!is_empty(${q.code}_other.NAOK)` : `${q.code}_${code}.NAOK == "Y"`;
    if (q.type === 'R') return `!is_empty(listifop('value', '==', '${code}', 'code', ',', ${q.answers.map((_, i) => `${q.code}_${i + 1}.sgqa`).join(', ')}))`;
    return `!is_empty(${q.code}_${code}.NAOK)`;
  }

  choiceValue(q, id) {
    if (q.textBoxes && q.textBoxes[id]) return `${q.textBoxes[id].code}.NAOK`;
    const code = q.choiceCode && q.choiceCode[id];
    if (['L', '!'].includes(q.type)) return `${q.code}.NAOK`;
    if (code === 'other' || code === '-oth-') return `${q.code}_other.NAOK`;
    return code ? `${q.code}_${code}.NAOK` : `${q.code}.NAOK`;
  }

  // Value of a q:// locator, as an expression.
  pathExpr(q, loc, where) {
    const id = loc.ids[0];
    const multi = q.sub;
    switch (loc.path) {
      case 'ChoiceTextEntryValue':
      case 'ChoiceNumericEntryValue':
        if (!id) return `${q.code}.NAOK`;
        return this.choiceValue(q, id);
      case 'QuestionText':
        return `${q.code}.question`;
      case 'SelectedChoicesCount':
        if (q.type === 'M') return `countif("Y", ${multi.map(s => `${q.code}_${s.code}.NAOK`).join(', ')})`;
        return `!is_empty(${q.code}.NAOK)`;
      case 'TotalSum':
        return `sum(${multi.map(s => `${q.code}_${s.code}.NAOK`).join(', ')})`;
      case 'ChoiceDescription':
        return JSON.stringify(strip(this.choiceText(q, id)));
      case 'SelectedChoicesRecode':
        if (q.type === 'M') return `listifop('value', '==', 'Y', 'code', ', ', ${multi.map(s => `${q.code}_${s.code}.sgqa`).join(', ')})`;
        return `${q.code}.NAOK`;
      case 'SelectedAnswerRecode':
      case 'SelectedAnswer': {
        const rc = q.choiceCode && q.choiceCode[id];
        if (!rc) break;
        return loc.path === 'SelectedAnswer' ? `${q.code}_${rc}.shown` : `${q.code}_${rc}.NAOK`;
      }
      case 'ChoiceGroup': {
        const what = loc.ids[0];
        if (what === 'SelectedChoices' || what === 'SelectedChoicesTextEntry') {
          if (q.type === 'M') {
            const list = `listifop('value', '==', 'Y', 'question', ', ', ${multi.map(s => `${q.code}_${s.code}.sgqa`).join(', ')})`;
            if (q.other !== 'Y') return list;
            return `join(${list}, if(is_empty(${q.code}_other.NAOK), "", join(if(is_empty(${list}), "", ", "), ${q.code}_other.NAOK)))`;
          }
          if (['L', '!'].includes(q.type)) return what === 'SelectedChoicesTextEntry' ? `${q.code}_other.NAOK` : `${q.code}.shown`;
          if (q.type === 'R') return `listifop('value', '!=', '', 'shown', ', ', ${q.answers.map((_, i) => `${q.code}_${i + 1}.sgqa`).join(', ')})`;
          break;
        }
        if (what === 'UnselectedChoices' && q.type === 'M') return `listifop('value', '!=', 'Y', 'question', ', ', ${multi.map(s => `${q.code}_${s.code}.sgqa`).join(', ')})`;
        if (what === 'AllChoices' || what === 'DisplayedChoices') {
          const all = (q.sub.length ? q.sub : q.answers).map(x => strip(x.raw));
          return JSON.stringify(all.join(', '));
        }
        break;
      }
    }
    this.problem(where, `This text shows a part of the answer to ${q.code} that LimeSurvey cannot show.`, 'Pipe the selected choices, the entered text or the question text instead.', [BLANK], { qualtrics: `Qualtrics fills in "${loc.path}" of ${q.code} inside the text (piped text).`, why: 'LimeSurvey can show the answer itself, but not this particular part of it.' });
    return '""';
  }

  choiceText(q, id) {
    const code = q.choiceCode && q.choiceCode[id];
    const x = [...q.sub, ...q.answers].find(s => s.code === code);
    return x ? x.raw : '';
  }

  fieldRef(field, where) {
    if (!this.vars[field]) {
      const tok = recipient(field);
      if (tok) return tok;
      this.varName(field);
      this.vars[field].urlParam = true;
      this.note(where, `The field "${field}" is used but never given a value in the survey flow. LimeSurvey fills it from the survey link, for example ...?${field}=value.`);
    }
    return this.vars[field].code;
  }

  // Replaces ${...} piped text in HTML with {expressions}. Literal braces are escaped so ExpressionScript ignores them.
  pipe(html, ctx) {
    if (!html) return '';
    let out = '';
    let last = 0;
    const re = /\$e\{([^}]*)\}|\$\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(html))) {
      out += escBraces(html.slice(last, m.index));
      last = re.lastIndex;
      const e = m[1] !== undefined ? this.math(m[1], ctx) : this.pipeExpr(m[2], ctx);
      out += e.literal !== undefined ? escBraces(e.literal) : `{${e.expr}}`;
    }
    return out + escBraces(html.slice(last));
  }

  // A value used in logic or embedded data: literal text with optional piped parts -> one expression.
  valueExpr(raw, ctx) {
    const s = String(raw);
    const parts = [];
    let last = 0;
    const re = /\$e\{([^}]*)\}|\$\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(JSON.stringify(s.slice(last, m.index)));
      last = re.lastIndex;
      const e = m[1] !== undefined ? this.math(m[1], ctx) : this.pipeExpr(m[2], ctx);
      parts.push(e.literal !== undefined ? JSON.stringify(e.literal) : e.expr);
    }
    if (last < s.length) parts.push(JSON.stringify(s.slice(last)));
    if (!parts.length) return '""';
    if (parts.length === 1) return /^"-?\d+(\.\d+)?"$/.test(parts[0]) ? parts[0].slice(1, -1) : parts[0];
    return `join(${parts.join(', ')})`;
  }

  // Qualtrics math: $e{ e://Field/a + q://QID1/ChoiceNumericEntryValue/1 * 2 }
  math(body, ctx) {
    const expr = body.replace(/(q|e):\/\/[A-Za-z0-9_#]+(\/[A-Za-z0-9_%]+)*/g, loc => {
      const r = this.pipeExpr(loc, ctx);
      return r.literal !== undefined ? JSON.stringify(r.literal) : `floatval(${r.expr})`;
    });
    if (/[^\s\d+\-*/().,"a-zA-Z_]/.test(expr.replace(/"[^"]*"/g, ''))) {
      this.problem(ctx.where, 'This text contains a calculation LimeSurvey cannot do.', 'Use + - * / and parentheses only, or compute the value in LimeSurvey with an equation question.', [BLANK], { qualtrics: `Qualtrics calculates "${body.trim()}" and shows the result in the text.`, why: 'The calculation uses functions the converter cannot translate.' });
      return { expr: '""' };
    }
    return { expr: expr.trim().replace(/\b(abs|round|floor|ceil|sqrt|pow|min|max|sum|log|exp)\b/gi, f => f.toLowerCase()) };
  }

  pipeExpr(inner, ctx) {
    const s = inner.trim();
    let m;
    if ((m = /^e:\/\/Field\/(.+)$/.exec(s))) return { expr: this.fieldRef(decodeURIComponent(m[1]), ctx.where) + '.NAOK' };
    if ((m = /^lm:\/\/Field\/(\d+)$/.exec(s))) {
      if (!ctx.iter) { this.problem(ctx.where, 'This text uses a loop value outside the loop.', 'Only use loop & merge fields inside the looping block.', [BLANK], { qualtrics: 'Qualtrics fills in a value from the current loop round, but this text is not inside the loop.', why: 'Outside the loop there is no current round, so there is no value to show.' }); return { literal: '' }; }
      return { literal: (ctx.iter.fields || {})[m[1]] ?? '' };
    }
    if (/^lm:\/\/(CurrentLoopNumber|CurrentIteration)/.test(s)) return { literal: ctx.iter ? String(ctx.iter.n) : '' };
    if ((m = /^rand:\/\/int\/(-?\d+):(-?\d+)$/.exec(s))) return { expr: `rand(${m[1]}, ${m[2]})` };
    if ((m = /^date:\/\/(CurrentDate|CurrentTime)\/(.+)$/.exec(s))) return { expr: `date(${JSON.stringify(dateFormat(m[1], decodeURIComponent(m[2])))})` };
    if ((m = /^m:\/\/(\w+)$/.exec(s))) {
      const tok = recipient(m[1]);
      if (tok) return { expr: tok };
    }
    if ((m = /^q:\/\//.exec(s))) {
      const loc = parseLoc(s);
      if (loc) {
        const q = this.ref(loc.qid + (loc.col ? '#col' + loc.col : ''), loc.iter ? { key: loc.iter } : ctx.iter);
        if (!q) { this.problem(ctx.where, `This text shows the answer to a question that is not in the survey (${(this.questions[loc.qid] || {}).DataExportTag || loc.qid}).`, 'Remove the piped text or restore the question.', [BLANK], { qualtrics: 'Qualtrics fills in the answer to a question that was deleted, moved to the trash, or left out on the Questions tab.', why: 'Without that question there is no answer to show.' }); return { literal: '' }; }
        return { expr: this.pathExpr(q, loc, ctx.where) };
      }
    }
    if ((m = /^gr:\/\/(SC_\w+)\/(Score|WeightedMean|WeightedStdDev)$/.exec(s)) && this.scores[m[1]]) {
      if (m[2] === 'Score') return { expr: this.scoreExpr(m[1]) };
    }
    this.problem(ctx.where, 'This text fills in a value LimeSurvey cannot provide.', s.startsWith('gr://') ? 'Use LimeSurvey assessments, or compute the score with an equation question.' : 'Remove the piped text, or replace it with an answer or embedded data field.', [BLANK], { qualtrics: `Qualtrics replaces \${${s}} with a value when the page is shown (piped text).`, why: 'LimeSurvey has no source for this value.' });
    return { literal: '' };
  }

  // ---------- scoring, device type, quotas ----------

  // Qualtrics scoring: GradingData gives points per choice and scoring category.
  scoring(q, p) {
    const gd = values(p.GradingData);
    for (const g of gd) {
      for (const [sc, pts] of Object.entries(g.Grades || {})) {
        if (!this.scores[sc] || pts === '' || pts === null || Number(pts) === 0) continue;
        (this.scores[sc].terms || (this.scores[sc].terms = [])).push({ q, choice: String(g.ChoiceID), answer: g.AnswerID !== undefined ? String(g.AnswerID) : undefined, pts: Number(pts) });
      }
    }
  }

  scoreExpr(id) {
    const sc = this.scores[id];
    const terms = (sc.terms || []).map(t => {
      let sel;
      if (t.answer !== undefined && t.q.answerCode) {
        const rc = t.q.choiceCode[t.choice], ac = t.q.answerCode[t.answer];
        sel = rc && ac ? `${t.q.code}_${rc}.NAOK == "${ac}"` : '';
      } else sel = t.q.choiceCode && t.q.choiceCode[t.choice] ? this.selected(t.q, t.choice, t.q.where) : '';
      return sel ? `if(${sel}, ${t.pts}, 0)` : '';
    }).filter(Boolean);
    sc.used = true;
    return terms.length ? `sum(${terms.join(', ')})` : '0';
  }

  // Scores are stored at the end, so the response data has them like Qualtrics' SC columns.
  scoreGroup() {
    const ids = Object.keys(this.scores).filter(id => (this.scores[id].terms || []).length);
    if (!ids.length) return;
    const g = this.newGroup('Scores', [], '');
    g.ends = [];
    for (const id of ids) {
      const q = this.newQuestion(g, `score${this.scores[id].name}`, '*', { where: `Score "${this.scores[id].name}"`, hidden: true });
      q.text[this.lang] = `{${this.scoreExpr(id)}}`;
    }
    this.note('Scoring', `Scores (${ids.map(id => this.scores[id].name).join(', ')}) are calculated automatically and saved with each response, as in Qualtrics. Respondents do not see the calculation.`);
  }

  // Device type is read by a small script on the first page into a hidden variable (words like "mobile iphone").
  deviceVar() {
    if (this.device) return this.device.code;
    const g = this.groups.find(x => x.questions.some(q => !q.hidden && q.type !== '*')) || this.groups[this.groups.length - 1];
    // Not "hidden": LimeSurvey does not render hidden questions, so the script would never run. CSS hides it instead.
    const q = this.newQuestion(g, 'devicetype', 'S', { where: 'Device type', finished: true });
    q.attrs.cssclass = 'd-none';
    g.questions.splice(g.questions.indexOf(q), 1);
    g.questions.unshift(q);
    q.text[this.lang] = 'Device type';
    q.script = "$(function() { var u = navigator.userAgent, t = []; var tablet = /iPad|Tablet/i.test(u) || (/Macintosh/.test(u) && 'ontouchend' in document); var phone = /Mobi|iPhone|iPod|Android.*Mobile/i.test(u); t.push(phone ? 'mobile' : tablet ? 'tablet mobile' : 'desktop computer'); if (/iPhone/.test(u)) t.push('iphone'); if (/iPad/.test(u) || tablet) t.push('ipad'); if (/Android/.test(u)) t.push('android'); if (/Windows Phone/.test(u)) t.push('windowsphone'); if (/BlackBerry/.test(u)) t.push('blackberry'); $('#answer{SGQ}').val(t.join(' ')); });";
    this.device = q;
    this.note('Device type', 'Questions that depend on the respondent\'s device (phone, tablet or computer) work from the second page on. On the first page the device is not known yet.', 'Keep device-dependent questions off the first page.');
    return q.code;
  }

  // Qualtrics quota -> LimeSurvey quota. LimeSurvey quotas count answer codes: AND across questions, OR within one.
  quota(qo, id) {
    const name = qo.Name || qo.QuotaName || `Quota ${id}`;
    const where = `Quota "${name}"`;
    const limit = Number(qo.Occurrences ?? qo.Quota ?? qo.Limit);
    const fail = why => { this.problem(where, why, 'Simplify the quota to "question = choice" conditions joined by AND (OR only between choices of the same question), or recreate it in LimeSurvey under Survey settings > Quotas.', [opt('drop', 'Leave the quota out', 'Nobody is stopped: the survey accepts any number of respondents for this group. You can add the quota in LimeSurvey later.')], { qualtrics: `Qualtrics counts respondents who match "${name}" and stops new ones once the limit is reached.`, why: 'LimeSurvey quotas only count simple "this answer was chosen" rules.' }); return null; };
    if (!Number.isFinite(limit)) return fail('The quota limit could not be read.');
    const logic = qo.Logic || qo.Condition;
    const items = [];
    for (const k of numKeys(logic || {})) for (const j of numKeys(logic[k])) items.push(logic[k][j]);
    if (!items.length) return fail('The quota has no conditions that could be read.');
    const members = [];
    let prev;
    for (const [i, it] of items.entries()) {
      const loc = parseLoc(it.LeftOperand || it.ChoiceLocator || '');
      const q = loc && this.ref(loc.qid);
      if (!q || it.Operator !== 'Selected' || loc.path !== 'SelectableChoice' || !['L', '!', 'M'].includes(q.type)) return fail('Only "choice is selected" conditions on multiple choice questions can become a LimeSurvey quota.');
      const conj = it.Conjuction || it.Conjunction;
      if (i > 0 && (conj === 'Or') !== (prev === q)) return fail('The quota mixes AND and OR in a way LimeSurvey quotas cannot express.');
      prev = q;
      members.push({ qid: q.qid, code: q.choiceCode[loc.ids[0]] });
    }
    const action = /End/i.test(qo.QuotaAction || qo.Action || 'EndCurrentSurvey') ? 1 : null;
    if (!action) return fail(`Quota action "${qo.QuotaAction}" cannot be converted.`);
    if (qo.LogicType && qo.LogicType !== 'Simple') this.note(where, 'This quota had an advanced setup in Qualtrics and became a simple quota: once it is full, new respondents who match it are stopped.', 'Check the quota in LimeSurvey (Survey settings, Quotas).');
    return { id, name, limit, members, message: strip((qo.EndSurveyOptions || {}).Message || '') };
  }

  // ---------- survey settings and output ----------

  surveyOptions() {
    const o = this.options;
    if (o.SurveyProtection === 'ByInvitation') this.note('Survey access', 'In Qualtrics only invited people could take part. In LimeSurvey anyone with the link can, until you change it.', 'Add a participant list in LimeSurvey to make the survey invitation-only.');
    if (o.PasswordProtection === 'Yes') this.note('Survey access', 'The survey password is not carried over.', 'Use a participant list with access codes in LimeSurvey instead.');
    if (o.Header || o.Footer) this.note('Survey look', 'Your custom header and footer are not carried over.', 'Add them to your LimeSurvey theme (Themes, Theme options).');
    if (o.SurveyExpiration === 'on' || o.SurveyExpirationDate) this.note('Survey access', 'The date the survey closes is not carried over.', 'Set it in LimeSurvey under Publication & access, Expiry date.');
  }

  writeLss(groups) {
    const L = this.langs;
    const qs = [], subs = [], l10n = [], attrs = [], answers = [], al10n = [], defs = [], dl10n = [];
    let l10nId = 1, aid = 1, dvid = 1;
    groups.forEach((g, gi) => {
      g.order = gi;
      const timed = g.timeLimit && g.questions.find(q => !q.hidden);
      if (timed) Object.assign(timed.attrs, { time_limit: g.timeLimit, time_limit_action: 2 });
      g.questions.forEach((q, qi) => {
        if (q.hidden) q.attrs.hidden = 1;
        qs.push(qRow(this.sid, g.gid, q, qi, 0, 0, q.relevance || '1'));
        for (const lg of L) l10n.push({ id: l10nId++, qid: q.qid, question: q.text[lg] ?? q.text[this.lang] ?? '', help: '', language: lg, script: q.script || '' });
        for (const [k, v] of Object.entries(q.attrs)) {
          if (v === undefined || v === null || v === '') continue;
          if (typeof v === 'object') for (const lg of L) attrs.push({ qid: q.qid, attribute: k, value: v[lg] ?? v[this.lang] ?? '', language: lg });
          else attrs.push({ qid: q.qid, attribute: k, value: String(v), language: '' });
        }
        const addSub = (list, scale) => list.forEach((s, si) => {
          const sq = { qid: this.nextId++, type: q.type, code: s.code, mandatory: 'N', other: 'N', preg: '' };
          s.qid = sq.qid;
          subs.push({ ...qRow(this.sid, g.gid, sq, si, q.qid, scale, s.relevance || '1') });
          for (const lg of L) l10n.push({ id: l10nId++, qid: sq.qid, question: s.text[lg] ?? s.text[this.lang], help: '', language: lg, script: '' });
        });
        addSub(q.sub, 0);
        addSub(q.sub2, 1);
        for (const d of q.defaults) {
          defs.push({ dvid: dvid, qid: q.qid, scale_id: 0, sqid: d.sub ? d.sub.qid : 0, specialtype: '' });
          for (const lg of L) dl10n.push({ id: l10nId++, dvid, language: lg, defaultvalue: d.value });
          dvid++;
        }
        q.answers.forEach((a, ai) => {
          answers.push({ aid, qid: q.qid, code: a.code, sortorder: ai, assessment_value: 0, scale_id: a.scale || 0 });
          for (const lg of L) al10n.push({ id: l10nId++, aid, answer: a.text[lg] ?? a.text[this.lang], language: lg });
          aid++;
        });
      });
    });
    const params = Object.values(this.vars).filter(v => v.urlParam).map((v, i) => ({ id: i + 1, sid: this.sid, parameter: Object.keys(this.vars).find(k => this.vars[k] === v), targetqid: v.qid }));
    const o = this.options;
    const survey = {
      sid: this.sid, gsid: 1, admin: '', adminemail: '', anonymized: o.AnonymizeResponse === 'Yes' ? 'Y' : 'N', format: 'G',
      savetimings: this.savetimings ? 'Y' : 'N', template: 'fruity_twentythree', language: this.lang, additional_languages: L.slice(1).join(' '),
      datestamp: 'Y', usecookie: o.BallotBoxStuffingPrevention === 'true' ? 'Y' : 'N', allowprev: o.BackButton === 'true' ? 'Y' : 'N',
      autoredirect: this.redirect ? 'Y' : 'N', showprogress: o.ProgressBarDisplay && o.ProgressBarDisplay !== 'None' ? 'Y' : 'N',
      usecaptcha: this.captcha ? 'A' : 'N', allowsave: o.SaveAndContinue === 'true' ? 'Y' : 'N', showwelcome: 'N', questionindex: this.questionIndex ? 1 : 0,
      printanswers: o.ResponseSummary && o.ResponseSummary !== 'No' ? 'Y' : 'N',
      showxquestions: 'N', showgroupinfo: 'N', shownoanswer: 'N', showqnumcode: o.ShowExportTags === 'true' ? 'C' : 'X',
    };
    const lsets = L.map(lg => ({
      surveyls_survey_id: this.sid, surveyls_language: lg, surveyls_title: this.title, surveyls_description: '', surveyls_welcometext: '',
      surveyls_endtext: '', surveyls_url: this.redirect || '', surveyls_urldescription: '', surveyls_dateformat: 1, surveyls_numberformat: 0,
    }));
    const grp = groups.map(g => ({ gid: g.gid, sid: this.sid, group_order: g.order, randomization_group: g.rgroup || '', grelevance: g.relevance || '1' }));
    const gl10n = [];
    for (const g of groups) for (const lg of L) gl10n.push({ id: l10nId++, gid: g.gid, group_name: g.name, description: '', language: lg });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<document>\n <LimeSurveyDocType>Survey</LimeSurveyDocType>\n <DBVersion>498</DBVersion>\n' +
      ` <languages>\n${L.map(l => `  <language>${l}</language>\n`).join('')} </languages>\n` +
      table('answers', answers) + table('answer_l10ns', al10n) + table('groups', grp) + table('group_l10ns', gl10n) +
      table('questions', qs) + table('subquestions', subs) + table('question_l10ns', l10n) + table('question_attributes', attrs) + table('defaultvalues', defs) + table('defaultvalue_l10ns', dl10n) +
      table('surveys', [survey]) + table('surveys_languagesettings', lsets) + table('survey_url_parameters', params) +
      table('quota', (this.quotaRows || []).map(r => ({ id: r.id, sid: this.sid, name: r.name, qlimit: r.limit, action: 1, active: 1, autoload_url: 0 }))) +
      table('quota_members', (this.quotaRows || []).flatMap(r => r.members.map((m, i) => ({ id: r.id * 1000 + i, sid: this.sid, qid: m.qid, quota_id: r.id, code: m.code })))) +
      table('quota_languagesettings', (this.quotaRows || []).flatMap(r => L.map((lg, i) => ({ quotals_id: r.id * 100 + i, quotals_quota_id: r.id, quotals_language: lg, quotals_name: r.name, quotals_message: r.message || 'Sorry, your responses have exceeded a quota on this survey.', quotals_url: '', quotals_urldescrip: '' })))) +
      '</document>\n';
  }
}

// ---------- helpers ----------

function qRow(sid, gid, q, order, parent, scale, relevance) {
  return {
    qid: q.qid, parent_qid: parent, sid, gid, type: q.type, title: q.code, preg: q.preg || '', other: q.other || 'N',
    mandatory: parent ? 'N' : q.mandatory || 'N', question_order: order, scale_id: scale, same_default: 0, relevance,
    modulename: '', encrypted: 'N', question_theme_name: THEMES[q.type] || '', same_script: 0,
  };
}

function table(name, rows) {
  if (!rows.length) return '';
  const fields = Object.keys(rows[0]);
  const cell = v => `<![CDATA[${String(v ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  return ` <${name}>\n  <fields>\n${fields.map(f => `   <fieldname>${f}</fieldname>\n`).join('')}  </fields>\n  <rows>\n` +
    rows.map(r => `   <row>\n${fields.map(f => `    <${f}>${cell(r[f])}</${f}>\n`).join('')}   </row>\n`).join('') + `  </rows>\n </${name}>\n`;
}

function add(list, x) { if (!list.some(y => y.where === x.where && y.issue === x.issue)) list.push(x); }
function values(o) { return Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : []; }
function numKeys(o) { return Object.keys(o).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b); }
function order(ids, obj) {
  const all = Object.keys(obj || {});
  const list = (Array.isArray(ids) && ids.length ? ids.map(String) : all).filter(id => obj && obj[id]);
  return [...list, ...all.filter(id => !list.includes(id))];
}
function display(c) { return (c && c.Display) || ''; }
function recode(p, id) { const r = p.RecodeValues; return r && !Array.isArray(r) ? r[id] : Array.isArray(r) ? r[id] : undefined; }
function strip(html) { return String(html || '').replace(/<\/?(span|div|p|br)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function escBraces(s) { return s.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;'); }
function lang(code) { const c = String(code).toUpperCase(); return LANGS[c] || c.toLowerCase(); }
function forced(s) { return s.ForceResponse === 'ON' ? (s.ForceResponseType === 'RequestResponse' ? 'S' : 'Y') : s.ForceResponse === 'RequestResponse' ? 'S' : 'N'; }
function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function and(parts) { const p = parts.filter(x => x && x !== '1'); return p.length ? p.map(x => (p.length > 1 && / or /.test(x) ? `(${x})` : x)).join(' and ') : ''; }
function joinConj(items) {
  const ors = [[]];
  items.forEach((it, i) => { if (i > 0 && /^or$/i.test(it.conj || '')) ors.push([]); ors[ors.length - 1].push(it.text); });
  const terms = ors.map(a => a.filter(Boolean)).filter(a => a.length).map(a => (a.length > 1 ? a.map(x => (/ or /.test(x) ? `(${x})` : x)).join(' and ') : a[0]));
  if (!terms.length) return '';
  return terms.length > 1 ? terms.map(t => (/ and /.test(t) ? `(${t})` : t)).join(' or ') : terms[0];
}
function isDefaultJs(js) { return !String(js).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/Qualtrics\.SurveyEngine\.add(OnPageSubmit|OnUnload|OnReady|Onload)\s*\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)\s*;?/g, '').trim(); }
function randomQuestions(o) { return o.RandomizeQuestions === 'true' || o.RandomizeQuestions === true || o.RandomizeQuestions === 'All'; }

function answerCode(rec, id, used) {
  let c = String(rec ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (!c || c.length > 5 || used.has(c)) c = String(id).replace(/[^A-Za-z0-9]/g, '').slice(-4);
  if (!c || used.has(c)) c = 'A' + String(id).replace(/[^A-Za-z0-9]/g, '').slice(-4);
  for (let i = 1; used.has(c); i++) c = 'A' + i;
  used.add(c);
  return c;
}
function subCode(rec, id, used) {
  let c = String(rec ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (!c || c.length > 20 || used.has(c.toLowerCase())) c = String(id).replace(/[^A-Za-z0-9]/g, '');
  if (['time', 'other'].includes(c.toLowerCase()) || /comment$/i.test(c)) c = 'SQ' + c;
  for (let i = 1; !c || used.has(c.toLowerCase()); i++) c = 'SQ' + i;
  used.add(c.toLowerCase());
  return c;
}

// q://QID12/SelectableChoice/3, q://2_QID12/ChoiceTextEntryValue, q://QID5/SelectableAnswer/1/2 ...
function parseLoc(s) {
  const m = /^q:\/\/(?:(\w+)_)?(QID\d+)(?:#(\d+))?\/([A-Za-z]+)((?:\/[^/]+)*)$/.exec(decodeURIComponent(String(s).split('?')[0]));
  if (!m) return null;
  return { iter: m[1], qid: m[2], col: m[3], path: m[4], ids: m[5] ? m[5].slice(1).split('/') : [] };
}

function compare(left, op, right, where, conv) {
  const r = right === '' ? '""' : right;
  const num = /^-?\d+(\.\d+)?$/.test(r);
  switch (op) {
    case 'EqualTo': case 'Is': return `${left} == ${r}`;
    case 'NotEqualTo': case 'IsNot': return `${left} != ${r}`;
    case 'GreaterThan': return `${left} > ${r}`;
    case 'GreaterThanOrEqual': return `${left} >= ${r}`;
    case 'LessThan': return `!is_empty(${left}) and ${left} < ${r}`;
    case 'LessThanOrEqual': return `!is_empty(${left}) and ${left} <= ${r}`;
    case 'Empty': return `is_empty(${left})`;
    case 'NotEmpty': return `!is_empty(${left})`;
    case 'Contains': return `!is_empty(stristr(${left}, ${num ? `"${r}"` : r}))`;
    case 'DoesNotContain': return `is_empty(stristr(${left}, ${num ? `"${r}"` : r}))`;
    case 'MatchesRegex': return `regexMatch(${JSON.stringify('/' + String(JSON.parse(num ? `"${r}"` : r)).replace(/\//g, '\\/') + '/')}, ${left})`;
    case 'Selected': return `!is_empty(${left})`;
    case 'NotSelected': return `is_empty(${left})`;
  }
  return conv.condProblem(where, `This condition compares answers in a way ("${op}") LimeSurvey cannot.`, 'Use equal, not equal, greater/less than, empty, contains or matches regex.', { qualtrics: `Qualtrics compares an answer using "${op}".` });
}

function choiceLogic(qid, id, op) {
  return { 0: { 0: { LogicType: 'Question', QuestionID: qid, Operator: op, LeftOperand: `q://${qid}/SelectableChoice/${id}`, Type: 'Expression' }, Type: 'If' }, Type: 'BooleanExpression' };
}
function numericLoop(qid, n) {
  return { 0: { 0: { LogicType: 'Question', QuestionID: qid, Operator: 'GreaterThanOrEqual', LeftOperand: `q://${qid}/ChoiceTextEntryValue`, RightOperand: String(n), Type: 'Expression' }, Type: 'If' }, Type: 'BooleanExpression' };
}

// Panel / recipient fields -> LimeSurvey participant (token) fields.
function recipient(field) {
  return { RecipientFirstName: 'TOKEN:FIRSTNAME', FirstName: 'TOKEN:FIRSTNAME', RecipientLastName: 'TOKEN:LASTNAME', LastName: 'TOKEN:LASTNAME', RecipientEmail: 'TOKEN:EMAIL', Email: 'TOKEN:EMAIL', Email1: 'TOKEN:EMAIL', ExternalDataReference: 'TOKEN:TOKEN', ExternalReference: 'TOKEN:TOKEN' }[field];
}

function dateFormat(kind, f) {
  const named = { SL: 'm/d/Y', FL: 'l, F j, Y', ISO: 'Y-m-d', PT: 'g:i:s A', TS: 'H:i:s', DS: 'd/m/Y' }[f];
  return named || f;
}
