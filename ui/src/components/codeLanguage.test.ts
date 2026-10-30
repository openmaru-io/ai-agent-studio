/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { languageOf } from './codeLanguage';

describe('languageOf', () => {
  it('파일 이름으로 색칠할 언어를 고른다', () => {
    expect(languageOf('SOUL.md', true)).toBe('markdown');
    expect(languageOf('config.yaml', false)).toBe('yaml');
    expect(languageOf('.env', false)).toBe('ini');
    expect(languageOf('run.py', false)).toBe('python');
    expect(languageOf('setup.sh', false)).toBe('shell');
    expect(languageOf('data.bin', false)).toBe('plaintext');
    expect(languageOf(undefined, false)).toBe('plaintext');
  });

  // 서버가 보여 주는 글 파일(aas/assets/files.py TEXT_EXT) 모두를 종류에 맞게 색칠한다(2026-10-17-024). 예전에는 .html 등이 글자만이었다
  it('웹·코드 파일도 종류별로 고르고, 템플릿 꼬리(.j2·.tmpl)는 앞의 확장자를 본다', () => {
    expect(languageOf('templates/template.html', false)).toBe('html');
    expect(languageOf('style.css', false)).toBe('css');
    expect(languageOf('app.js', false)).toBe('javascript');
    expect(languageOf('app.ts', false)).toBe('typescript');
    expect(languageOf('data.json', false)).toBe('json');
    expect(languageOf('q.sql', false)).toBe('sql');
    expect(languageOf('pyproject.toml', false)).toBe('ini');
    expect(languageOf('page.html.j2', false)).toBe('html');
    expect(languageOf('config.yaml.tmpl', false)).toBe('yaml');
    expect(languageOf('notes.txt', false)).toBe('plaintext');
    expect(languageOf('prompt.j2', false)).toBe('plaintext');
  });

  // 파일 뷰어 원문 보기에서 늘린 언어(2026-10-20-002 D7). 아래 짝 검사도 이 표의 언어를 모두 본다
  const VIEWER: Record<string, string> = {
    'pom.xml': 'xml', 'icon.svg': 'xml', 'schema.xsd': 'xml', 'page.xsl': 'xml', 'Info.plist': 'xml',
    'Main.java': 'java', 'App.kt': 'kotlin', 'build.gradle.kts': 'kotlin', 'Main.scala': 'scala', 'build.sc': 'scala',
    'main.go': 'go', 'lib.rs': 'rust',
    'a.c': 'cpp', 'a.h': 'cpp', 'a.cc': 'cpp', 'a.cpp': 'cpp', 'a.cxx': 'cpp', 'a.hpp': 'cpp', 'Program.cs': 'csharp',
    'index.php': 'php', 'app.rb': 'ruby', 'run.pl': 'perl', 'Mod.pm': 'perl', 'init.lua': 'lua', 'plot.R': 'r', 'App.swift': 'swift',
    'setup.ps1': 'powershell', 'Mod.psm1': 'powershell', 'run.bat': 'bat', 'run.cmd': 'bat',
    Dockerfile: 'dockerfile', 'deploy/Dockerfile': 'dockerfile', 'web.dockerfile': 'dockerfile',
    'style.scss': 'scss', 'style.less': 'less',
    'schema.graphql': 'graphql', 'q.gql': 'graphql', 'api.proto': 'protobuf', 'main.tf': 'hcl', 'prod.tfvars': 'hcl', 'conf.hcl': 'hcl',
    // 기존 언어로 보내는 확장자
    'App.jsx': 'javascript', 'App.tsx': 'typescript', 'a.mts': 'typescript', 'a.cts': 'typescript', 'index.htm': 'html',
    'nginx.conf': 'ini', 'setup.cfg': 'ini', 'init.zsh': 'shell', 'README.markdown': 'markdown', 'Dockerfile.j2': 'dockerfile',
  };

  it('파일 뷰어 원문 보기 언어(D7): 확장자·이름으로 고르고, 모르는 것은 글자만', () => {
    for (const [name, lang] of Object.entries(VIEWER)) expect(languageOf(name, false), name).toBe(lang);
    expect(languageOf('Dockerfile.dev', false)).toBe('plaintext');
    expect(languageOf('mydockerfile', false)).toBe('plaintext');
    expect(languageOf('report.xlsx', false)).toBe('plaintext');
    expect(languageOf('Makefile', false)).toBe('plaintext');
  });

  it('고를 수 있는 언어는 모두 편집기 준비(monacoSetup)에 색칠이 들어 있다', () => {
    const setup = readFileSync(join(__dirname, '../lib/monacoSetup.ts'), 'utf-8');
    const langs = new Set(['markdown', 'yaml', 'ini', 'python', 'shell', 'html', 'css', 'javascript', 'typescript', 'sql', ...Object.values(VIEWER)]);
    for (const lang of langs) {
      expect(setup, lang).toContain(`basic-languages/${lang}/${lang}.contribution`);
    }
    expect(setup).toMatch(/id: 'json'/); // json 은 basic-languages 에 없어 따로 등록한다
  });
});
