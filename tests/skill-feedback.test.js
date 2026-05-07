const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Skill Feedback Module', () => {
  let tmpDir, feedbackModule;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-feedback-'));
    delete require.cache[require.resolve('../server/skill-feedback')];
    feedbackModule = require('../server/skill-feedback');
    feedbackModule._setBaseDir(tmpDir);
  });

  describe('recordSignal', () => {
    it('appends a signal to the JSONL log and returns recorded:true', () => {
      const result = feedbackModule.recordSignal({
        skillName: 'superpowers:brainstorming',
        type: 'correction',
        summary: 'Visual companion fired for non-UI task',
      });
      assert.equal(result.recorded, true);

      const logFile = path.join(tmpDir, 'skill-feedback-log.jsonl');
      assert.ok(fs.existsSync(logFile));
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const signal = JSON.parse(lines[0]);
      assert.equal(signal.skillName, 'superpowers:brainstorming');
      assert.equal(signal.type, 'correction');
      assert.ok(signal.timestamp);
    });

    it('increments threshold counter for corrections', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'a' });
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'b' });

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'].corrections, 2);
      assert.equal(thresholds['test:skill'].needsReview, false);
    });

    it('flags needsReview at 3 corrections', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'a' });
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'b' });
      const result = feedbackModule.recordSignal({ skillName: 'test:skill', type: 'correction', summary: 'c' });

      assert.deepStrictEqual(result.needsReview, ['test:skill']);
      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'].needsReview, true);
    });

    it('does not increment threshold for activation type', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'activation', summary: '' });

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'], undefined);
    });

    it('includes sessionId and project when provided', () => {
      feedbackModule.recordSignal({
        skillName: 'test:skill',
        type: 'lesson',
        summary: 'x',
        sessionId: 'sess-1',
        project: 'my-project',
      });

      const logFile = path.join(tmpDir, 'skill-feedback-log.jsonl');
      const signal = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      assert.equal(signal.sessionId, 'sess-1');
      assert.equal(signal.project, 'my-project');
    });

    it('increments threshold for lesson type', () => {
      feedbackModule.recordSignal({ skillName: 'test:skill', type: 'lesson', summary: 'a' });
      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['test:skill'].corrections, 1);
    });
  });

  describe('getHealth', () => {
    it('returns empty when no signals exist', () => {
      const health = feedbackModule.getHealth();
      assert.deepStrictEqual(health.flagged, []);
      assert.equal(health.totalSignals, 0);
    });

    it('returns flagged skills and total signal count', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'correction', summary: '1' });

      const health = feedbackModule.getHealth();
      assert.equal(health.flagged.length, 1);
      assert.equal(health.flagged[0].skillName, 'a:skill');
      assert.equal(health.flagged[0].corrections, 3);
      assert.equal(health.totalSignals, 4);
    });
  });

  describe('clearSkill', () => {
    it('resets threshold for a skill', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });

      feedbackModule.clearSkill('a:skill');

      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['a:skill'], undefined);
    });

    it('marks signals as resolved in the log', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'correction', summary: '2' });

      feedbackModule.clearSkill('a:skill');

      const logFile = path.join(tmpDir, 'skill-feedback-log.jsonl');
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const aSignals = lines.filter(s => s.skillName === 'a:skill');
      assert.ok(aSignals.every(s => s.resolved === true));
      const bSignals = lines.filter(s => s.skillName === 'b:skill');
      assert.ok(bSignals.every(s => !s.resolved));
    });
  });

  describe('getSignalsForSkill', () => {
    it('returns signals filtered by skill name', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: 'first' });
      feedbackModule.recordSignal({ skillName: 'b:skill', type: 'correction', summary: 'other' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'lesson', summary: 'second' });

      const signals = feedbackModule.getSignalsForSkill('a:skill');
      assert.equal(signals.length, 2);
      assert.equal(signals[0].summary, 'first');
      assert.equal(signals[1].summary, 'second');
    });

    it('excludes resolved signals by default', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '2' });
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '3' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getSignalsForSkill('a:skill');
      assert.equal(signals.length, 0);
    });

    it('includes resolved signals when requested', () => {
      feedbackModule.recordSignal({ skillName: 'a:skill', type: 'correction', summary: '1' });
      feedbackModule.clearSkill('a:skill');

      const signals = feedbackModule.getSignalsForSkill('a:skill', { includeResolved: true });
      assert.equal(signals.length, 1);
    });
  });

  describe('rolling window expiry', () => {
    it('does not count corrections older than 7 days toward threshold', () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const logFile = path.join(tmpDir, 'skill-feedback-log.jsonl');
      fs.writeFileSync(logFile,
        JSON.stringify({ skillName: 'old:skill', type: 'correction', summary: 'old1', timestamp: oldDate }) + '\n' +
        JSON.stringify({ skillName: 'old:skill', type: 'correction', summary: 'old2', timestamp: oldDate }) + '\n'
      );
      const threshFile = path.join(tmpDir, 'skill-feedback-thresholds.json');
      fs.writeFileSync(threshFile, JSON.stringify({
        'old:skill': { corrections: 2, needsReview: false }
      }));

      feedbackModule.recount();
      const thresholds = feedbackModule.getThresholds();
      assert.equal(thresholds['old:skill'], undefined);
    });
  });
});
