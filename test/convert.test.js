import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from '../src/qsf2lss.js';

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const has = (lss, text) => assert.ok(lss.includes(text), `expected .lss to contain: ${text}`);

test('kitchen sink converts every behaviour without problems', () => {
  const r = convert(fixture('kitchen-sink.qsf'));
  assert.deepEqual(r.problems, []);
  const { lss } = r;
  // display logic with OR, skip logic (end of survey, skip to question)
  has(lss, '(fruits_1.NAOK == "Y" or fruits_2.NAOK == "Y") and !(likes.NAOK == "2")');
  has(lss, '!(!is_empty(age.NAOK) and age.NAOK < 30)');
  // branch with end of survey, and embedded data branch
  has(lss, 'score.NAOK > 3 and !(likes.NAOK == "2") and !(why.NAOK == "stop")');
  // embedded data: literal, math, URL parameter
  has(lss, '{score = 5}');
  has(lss, '{score = floatval(score.NAOK) + 1}');
  has(lss, '<parameter><![CDATA[group]]></parameter>');
  // piped text
  has(lss, "{listifop('value', '==', 'Y', 'question', ', ', fruits_1.sgqa, fruits_2.sgqa, fruits_3.sgqa, fruits_4.sgqa)}");
  has(lss, 'lucky {rand(1, 5)}');
  // loops: static with in-loop logic, and over selected choices
  has(lss, 'Do you like blue?');
  has(lss, 'loopqL2.NAOK == "1"');
  has(lss, 'How often do you eat Cherry?');
  // carry forward, choice display logic on single and multiple answer questions
  has(lss, '<relevance><![CDATA[fruits_3.NAOK == "Y"]]></relevance>');
  has(lss, '{drinkfilter_2 = if(likes.NAOK == "1", "Y", "")}');
  has(lss, '<value><![CDATA[drinkfilter]]></value>');
  // randomizers: subset of 1, and all blocks in random order
  has(lss, '((rndFL14x2.NAOK < rndFL14x1.NAOK)) < 1');
  assert.equal((lss.match(/<randomization_group><!\[CDATA\[rg\d+\]\]>/g) || []).length, 4);
  // validation, translations, defaults
  has(lss, '<mandatory><![CDATA[Y]]></mandatory>');
  has(lss, '<value><![CDATA[!is_empty(stristr(code.NAOK, "x"))]]></value>');
  has(lss, 'Houdt u van fruit?');
  has(lss, '<defaultvalue><![CDATA[abc]]></defaultvalue>');
  // scoring, device type, quotas, end URL per path, timing, extra question types
  has(lss, 'Fruit score {sum(if(likes.NAOK == "1", 2, 0), if(fruits_1.NAOK == "Y", 1, 0), if(fruits_3.NAOK == "Y", 5, 0))}');
  has(lss, '!is_empty(stristr(devicetype.NAOK, "mobile"))');
  has(lss, '<quota_members>');
  has(lss, '{if(why.NAOK == "stop", "https://example.org/stopped", "https://example.org/done")}');
  has(lss, '<attribute><![CDATA[time_limit]]></attribute>');
  has(lss, '<type><![CDATA[H]]></type>');
  has(lss, '{ResponseID = SAVEDID}');
});

const blocked = {
    SurveyEntry: { SurveyName: 'x', SurveyLanguage: 'EN' },
    SurveyElements: [
      { Element: 'BL', Payload: [{ Type: 'Standard', ID: 'BL_1', Description: 'B', BlockElements: [{ Type: 'Question', QuestionID: 'QID1' }] }] },
      { Element: 'FL', Payload: { Type: 'Root', Flow: [{ Type: 'Branch', FlowID: 'FL_2', BranchLogic: { 0: { 0: { LogicType: 'GeoIP', Operator: 'Is', LeftOperand: 'NL', Type: 'Expression' }, Type: 'If' }, Type: 'BooleanExpression' }, Flow: [{ Type: 'Standard', ID: 'BL_1' }] }] } },
      { Element: 'SQ', Payload: { QuestionID: 'QID1', DataExportTag: 'Q1', QuestionType: 'MC', Selector: 'SAVR', QuestionText: 'Hi', Choices: { 1: { Display: 'a' } }, QuestionJS: 'Qualtrics.SurveyEngine.addOnload(function(){ this.hideNextButton(); });' } },
    ],
};

test('unconvertible parts are listed with a fix and options, and block the output', () => {
  const r = convert(blocked);
  assert.equal(r.lss, '');
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.every(p => p.id && p.where && p.issue && p.qualtrics && p.why && p.fix && p.options.length && p.options.every(o => o.label && o.impact)));
});

test('chosen options resolve problems, and edits change the output', () => {
  const pick = key => convert(blocked).problems.find(p => p.options.some(o => o.key === key)).id;
  const choices = { [pick('false')]: 'false', [pick('drop')]: 'drop' };
  const r = convert(blocked, { choices, title: 'Renamed', edits: { QID1: { code: 'intro', mandatory: 'Y' } } });
  assert.deepEqual(r.problems, []);
  assert.equal(r.notes.filter(n => n.fix.startsWith('Your choice:')).length, 2);
  has(r.lss, '<grelevance><![CDATA[0]]></grelevance>');
  has(r.lss, '<title><![CDATA[intro]]></title>');
  has(r.lss, '<surveyls_title><![CDATA[Renamed]]></surveyls_title>');
  has(r.lss, '<mandatory><![CDATA[Y]]></mandatory>');
  assert.equal(r.items[0].id, 'QID1');
  const skipped = convert(blocked, { choices, edits: { QID1: { skip: true } } });
  assert.equal(skipped.stats.questions, 0);
});

test('real survey with loop & merge on a numeric answer converts', () => {
  const r = convert(fixture('households.qsf'));
  assert.deepEqual(r.problems, []);
  has(r.lss, 'size.NAOK >= 20');
});
