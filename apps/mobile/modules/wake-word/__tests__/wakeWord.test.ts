// The WakeWord module: pure payload helpers, plus source-scanning guards that keep the Swift side,
// the JS side and the build config in step (nothing native runs in node).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTEXTUAL_STRINGS,
  DEFAULT_LOCALE,
  STATE_EVENT,
  TRANSCRIPT_EVENT,
  WAKE_WORD_MODULE,
  normalizeStartOptions,
  permissionsGranted,
  startFailure,
  toPermissions,
  toStartResult,
  toStateEvent,
  toTranscriptEvent,
} from '../src/payload';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), 'utf8');

describe('native contract (Swift <-> JS)', () => {
  const moduleSwift = read('../ios/WakeWordModule.swift');
  const listenerSwift = read('../ios/WakeListener.swift');
  const indexTs = read('../index.ts');
  const typesTs = read('../src/types.ts');

  it('autolinks WakeWordModule for apple only', () => {
    const config = JSON.parse(read('../expo-module.config.json')) as {
      platforms: string[];
      apple: { modules: string[] };
    };
    expect(config.platforms).toEqual(['apple']);
    expect(config.apple.modules).toEqual(['WakeWordModule']);
    expect(moduleSwift).toContain('public final class WakeWordModule: Module');
  });

  it('uses one module name on both sides', () => {
    expect(WAKE_WORD_MODULE).toBe('WakeWord');
    expect(moduleSwift).toContain(`Name("${WAKE_WORD_MODULE}")`);
    expect(indexTs).toContain('requireOptionalNativeModule<WakeWordModule>(WAKE_WORD_MODULE)');
  });

  it('declares the events JS listens to and emits them from the listener', () => {
    expect(moduleSwift).toContain(`Events("${TRANSCRIPT_EVENT}", "${STATE_EVENT}")`);
    expect(listenerSwift).toContain(
      `emit?("${TRANSCRIPT_EVENT}", ["text": text, "isFinal": isFinal, "segment": seg])`,
    );
    expect(listenerSwift).toContain(`emit?("${STATE_EVENT}", body)`);
  });

  it('defines every function the WakeWordModule type promises', () => {
    expect(moduleSwift).toContain('Function("isAvailable")');
    for (const fn of ['requestPermissions', 'start', 'stop']) {
      expect(moduleSwift).toContain(`AsyncFunction("${fn}")`);
    }
    for (const sig of ['isAvailable(', 'requestPermissions(', 'start(', 'stop(', 'addListener<']) {
      expect(typesTs).toContain(sig);
    }
  });

  it('emits only the states the types allow', () => {
    const emitted = [...listenerSwift.matchAll(/emitState\("([a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(emitted)).toEqual(
      new Set(['listening', 'stopped', 'restarting', 'error', 'interrupted']),
    );
    for (const state of emitted) expect(toStateEvent({ state })).toEqual({ state });
  });

  it('applies the same defaults natively', () => {
    expect(moduleSwift).toContain(`static let defaultLocale = "${DEFAULT_LOCALE}"`);
    const swiftStrings = DEFAULT_CONTEXTUAL_STRINGS.map((s) => `"${s}"`).join(', ');
    expect(moduleSwift).toContain(`static let defaultContextualStrings = [${swiftStrings}]`);
    expect(moduleSwift).toContain('onDevice: options?.onDevice ?? true');
  });

  it('releases the mic in the order the contract promises before stop resolves', () => {
    const teardown = listenerSwift.slice(listenerSwift.indexOf('private func teardown('));
    const order = ['cancelTask()', 'stopAudioPipeline()', 'deactivateSession()'].map((s) =>
      teardown.indexOf(s),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(listenerSwift).toContain('setActive(false, options: .notifyOthersOnDeactivation)');
    expect(listenerSwift).toContain('engine.inputNode.removeTap(onBus: 0)');
  });

  it('configures recognition as specified', () => {
    for (const line of [
      'request.shouldReportPartialResults = true',
      'request.taskHint = .dictation',
      'request.contextualStrings = options.contextualStrings',
      'request.requiresOnDeviceRecognition = onDeviceActive',
      'opts.onDevice && recognizer.supportsOnDeviceRecognition',
      'input.outputFormat(forBus: 0)',
      'format.sampleRate > 0',
      'static let taskMaxSeconds: Double = 50',
      'static let longTranscriptChars = 200',
    ]) {
      expect(listenerSwift).toContain(line);
    }
  });

  it('never prompts without the Info.plist usage strings (iOS would kill the app)', () => {
    expect(listenerSwift).toContain('hasUsageDescription("NSSpeechRecognitionUsageDescription")');
    expect(listenerSwift).toContain('hasUsageDescription("NSMicrophoneUsageDescription")');
  });

  it('does not throw at import time without the native module', () => {
    // The only top-level native lookup goes through loadNativeModule (try/catch, optional).
    const topLevel = indexTs
      .split('\n')
      .filter((l) => /^(const|let|export const)\b/.test(l) && /require(Optional)?Native/.test(l));
    expect(topLevel).toEqual([]);
    expect(indexTs).not.toMatch(/\brequireNativeModule\b/);
  });
});

describe('build config', () => {
  type AppJson = {
    expo: { ios: { deploymentTarget: string; infoPlist?: Record<string, string> } };
  };
  const app = (JSON.parse(read('../../../app.json')) as AppJson).expo;

  it('targets the app deployment target and links Speech + AVFoundation', () => {
    const podspec = read('../ios/WakeWord.podspec');
    expect(podspec).toContain(`:ios => '${app.ios.deploymentTarget}'`);
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    expect(podspec).toContain("s.frameworks = 'Speech', 'AVFoundation'");
  });

  it('has both usage strings in app.json (requestPermissions reports denied without them)', () => {
    const plist = app.ios.infoPlist ?? {};
    expect(plist.NSSpeechRecognitionUsageDescription ?? '').not.toBe('');
    expect(plist.NSMicrophoneUsageDescription ?? '').not.toBe('');
  });

  it('uploads the module ios/ folder to EAS (the repo-wide ios/ rule would drop it)', () => {
    const rules = read('../../../../../.easignore')
      .split('\n')
      .map((l) => l.trim());
    const drop = rules.indexOf('ios/');
    const keep = rules.indexOf('!apps/mobile/modules/*/ios/');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(keep).toBeGreaterThan(drop);
  });
});

describe('normalizeStartOptions', () => {
  it('fills the defaults', () => {
    expect(normalizeStartOptions()).toEqual({
      locale: 'en-US',
      contextualStrings: ['Jarvis'],
      onDevice: true,
    });
    expect(normalizeStartOptions({})).toEqual(normalizeStartOptions());
  });

  it('keeps valid options', () => {
    expect(
      normalizeStartOptions({
        locale: 'en-GB',
        contextualStrings: ['Jarvis', 'Hey Jarvis'],
        onDevice: false,
      }),
    ).toEqual({ locale: 'en-GB', contextualStrings: ['Jarvis', 'Hey Jarvis'], onDevice: false });
  });

  it('trims, drops blanks and case-insensitive duplicates', () => {
    expect(
      normalizeStartOptions({ locale: '  ', contextualStrings: [' Jarvis ', 'jarvis', '', '  '] }),
    ).toEqual({ locale: 'en-US', contextualStrings: ['Jarvis'], onDevice: true });
  });

  it('survives garbage from untyped callers', () => {
    const bad = {
      locale: 42,
      contextualStrings: 'Jarvis',
      onDevice: 'yes',
    } as unknown as Parameters<typeof normalizeStartOptions>[0];
    expect(normalizeStartOptions(bad)).toEqual({
      locale: 'en-US',
      contextualStrings: ['Jarvis'],
      onDevice: true,
    });
    const mixed = { contextualStrings: [7, 'Friday', null] } as unknown as Parameters<
      typeof normalizeStartOptions
    >[0];
    expect(normalizeStartOptions(mixed).contextualStrings).toEqual(['Friday']);
  });

  it('returns a fresh default array (callers cannot mutate the constant)', () => {
    const a = normalizeStartOptions();
    a.contextualStrings.push('x');
    expect(DEFAULT_CONTEXTUAL_STRINGS).toEqual(['Jarvis']);
  });
});

describe('toTranscriptEvent', () => {
  it('keeps a well-formed event', () => {
    expect(toTranscriptEvent({ text: 'Jarvis, I bet', isFinal: false, segment: 3 })).toEqual({
      text: 'Jarvis, I bet',
      isFinal: false,
      segment: 3,
    });
    expect(toTranscriptEvent({ text: '', isFinal: true, segment: 0 })).toEqual({
      text: '',
      isFinal: true,
      segment: 0,
    });
  });

  it('reads a missing or non-boolean isFinal as false', () => {
    expect(toTranscriptEvent({ text: 'hi', segment: 1 })?.isFinal).toBe(false);
    expect(toTranscriptEvent({ text: 'hi', isFinal: 1, segment: 1 })?.isFinal).toBe(false);
  });

  it('rejects malformed payloads', () => {
    for (const raw of [
      null,
      undefined,
      'Jarvis',
      [],
      { text: 5, segment: 1 },
      { text: 'hi' },
      { text: 'hi', segment: -1 },
      { text: 'hi', segment: 1.5 },
      { text: 'hi', segment: Number.NaN },
    ]) {
      expect(toTranscriptEvent(raw)).toBeNull();
    }
  });
});

describe('toStateEvent', () => {
  it('keeps known states and a non-empty message', () => {
    expect(toStateEvent({ state: 'listening' })).toEqual({ state: 'listening' });
    expect(toStateEvent({ state: 'error', message: 'boom' })).toEqual({
      state: 'error',
      message: 'boom',
    });
    expect(toStateEvent({ state: 'restarting', message: '' })).toEqual({ state: 'restarting' });
    expect(toStateEvent({ state: 'interrupted', message: 3 })).toEqual({ state: 'interrupted' });
  });

  it('rejects unknown states', () => {
    for (const raw of [null, {}, { state: 'LISTENING' }, { state: 'paused' }, { state: 1 }]) {
      expect(toStateEvent(raw)).toBeNull();
    }
  });
});

describe('toStartResult', () => {
  it('keeps a success', () => {
    expect(toStartResult({ ok: true, onDevice: true })).toEqual({ ok: true, onDevice: true });
    expect(toStartResult({ ok: true, onDevice: false })).toEqual({ ok: true, onDevice: false });
  });

  it('keeps a failure reason, or says unknown', () => {
    expect(toStartResult({ ok: false, onDevice: false, reason: 'mic-permission' })).toEqual({
      ok: false,
      onDevice: false,
      reason: 'mic-permission',
    });
    expect(toStartResult({ ok: false })).toEqual({ ok: false, onDevice: false, reason: 'unknown' });
  });

  it('reads malformed results as a failed start', () => {
    for (const raw of [null, undefined, 'ok', {}, { ok: 'true' }]) {
      expect(toStartResult(raw)).toEqual({
        ok: false,
        onDevice: false,
        reason: 'bad-native-result',
      });
    }
  });

  it('startFailure builds the same shape', () => {
    expect(startFailure('unavailable')).toEqual({
      ok: false,
      onDevice: false,
      reason: 'unavailable',
    });
  });
});

describe('toPermissions', () => {
  it('keeps known statuses', () => {
    expect(toPermissions({ speech: 'restricted', mic: 'granted' })).toEqual({
      speech: 'restricted',
      mic: 'granted',
    });
  });

  it('reads unknown values as undetermined (mic has no restricted state)', () => {
    expect(toPermissions(null)).toEqual({ speech: 'undetermined', mic: 'undetermined' });
    expect(toPermissions({ speech: 'yes', mic: 'restricted' })).toEqual({
      speech: 'undetermined',
      mic: 'undetermined',
    });
  });

  it('permissionsGranted needs both', () => {
    expect(permissionsGranted({ speech: 'granted', mic: 'granted' })).toBe(true);
    expect(permissionsGranted({ speech: 'granted', mic: 'denied' })).toBe(false);
    expect(permissionsGranted({ speech: 'undetermined', mic: 'granted' })).toBe(false);
  });
});
