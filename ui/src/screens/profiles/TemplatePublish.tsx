/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 상세의 「템플릿으로 올리기」 창(스펙 2026-11-18-002 §4-1·§4-4, 2단계).
// 위에서 아래로: 구역(기본 제한 구역) → 이름·설명 → 담을 것 → SOUL → 미리 보기(막는 오류·경고·필요 KEY) → 올리기 → 결과.
// 미리 보기는 게시와 같은 서버 함수(dry_run)를 쓴다. 승인 단계는 없다(D2) — 막는 오류가 없으면 바로 허브에 올라간다.

import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';

import {
  type Choices,
  choicesAfterToggle,
  fmtSize,
  type PickedFile,
  type PreviewItem,
  setConfirmed,
  type TemplatePreview,
  togglePick,
  zoneDefault,
} from './templatePublishState';

interface WorkspaceFiles {
  items: { path: string; size: number }[];
  max_files: number;
  max_bytes: number;
}

interface Mine {
  items: { id: string; name: string; version: string; namespace: string; status: string; ts: string; profile: string }[];
  limit: number;
  used: number;
  namespaces: string[];
  namespace_labels: Record<string, string>;
  public: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function TemplatePublish({ profile }: { profile: string }) {
  const confirm = useConfirm();
  const mine = useQuery<Mine>({ queryKey: ['market-templates-mine'], queryFn: () => get('/api/market/templates/mine'), retry: false });
  const [zone, setZone] = useState('');
  const [name, setName] = useState(profile.replace(/_/g, '-'));
  const [description, setDescription] = useState('');
  const [choices, setChoices] = useState<Choices | null>(null);
  const [soul, setSoul] = useState<string | null>(null);
  const [agents, setAgents] = useState<boolean | null>(null);
  const [examples, setExamples] = useState('');
  // KEY 마다 받는 사람에게 보일 한 줄 설명. MCP 에서 꺼낸 KEY 는 서버 설명이 비어 있다(OKE my-template, 2026-11-18)
  const [keyNotes, setKeyNotes] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<PickedFile[]>([]);
  // 공용 구역에 사내 주소·사설 IP 가 있어도 올린다는 확인(사내 공유, 스펙 2026-11-18-010). 사람만 체크한다 — MCP 도구는 넘기지 않는다
  const [allowInternal, setAllowInternal] = useState(false);
  const ws = useQuery<WorkspaceFiles>({ queryKey: ['template-workspace-files'], queryFn: () => get('/api/market/template/files'), retry: false });
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TemplatePreview | null>(null);
  const [publishError, setPublishError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (mine.data && !zone) setZone(zoneDefault(mine.data.namespaces, mine.data.public));
  }, [mine.data, zone]);

  const body = useMemo(
    () => ({
      profile,
      name,
      description,
      namespace: zone,
      ...(choices ? { choices } : {}),
      ...(soul !== null ? { soul_override: soul } : {}),
      ...(agents !== null ? { agents } : {}),
      files: picked,
      examples: examples
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 5),
      ...(allowInternal ? { allow_internal: true } : {}),
      key_notes: Object.fromEntries(Object.entries(keyNotes).filter(([, v]) => v.trim())),
    }),
    [profile, name, description, zone, choices, soul, agents, picked, examples, allowInternal, keyNotes]
  );
  const ready = !!zone && NAME_RE.test(name) && description.trim().length >= 20;

  // 구역·담을 것·SOUL 을 바꾸면 검사를 다시 돌린다(0.6초 쉬고 마지막 것만)
  useEffect(() => {
    if (!ready || result) return;
    const my = ++seq.current;
    const timer = window.setTimeout(async () => {
      setChecking(true);
      try {
        const r = await post<TemplatePreview>('/api/market/template/publish', { ...body, dry_run: true });
        if (my === seq.current) {
          setPreview(r);
          setPreviewError('');
        }
      } catch (e) {
        if (my === seq.current) setPreviewError((e as Error).message);
      } finally {
        if (my === seq.current) setChecking(false);
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [body, ready, result]);

  const publish = async () => {
    setBusy(true);
    setPublishError('');
    try {
      const r = await post<TemplatePreview>('/api/market/template/publish', body);
      setResult(r);
      void mine.refetch();
    } catch (e) {
      const err = e as ApiError;
      setPublishError(err.reason === 'publish_daily_limit' ? t('profiles.tplPub.dailyLimit', { limit: mine.data?.limit ?? 0 }) : err.message);
    } finally {
      setBusy(false);
    }
  };

  const takeDown = async (n: string) => {
    if (!(await confirm(t('profiles.tplPub.takeDownConfirm', { name: n }), { danger: true, confirmLabel: t('profiles.tplPub.takeDown') }))) return;
    try {
      await post('/api/market/template/unpublish', { name: n });
      void mine.refetch();
    } catch (e) {
      setPublishError((e as Error).message);
    }
  };

  const labels = mine.data?.namespace_labels ?? {};
  const isPublic = !!mine.data?.public.includes(zone);
  const errors = preview?.errors ?? [];
  // 확인 칸은 사내 주소 오류가 있을 때와, 이미 체크해 경고로 바뀐 때 보인다
  const internalAsk = errors.some((e) => e.code === 'internal_ref') || !!preview?.warnings.some((w) => w.code === 'internal_ref_ok');
  const needs = preview?.needs_confirmation ?? [];
  const fileInfo = new Map((preview?.items.files ?? []).map((f) => [f.id, f]));
  const pickedBytes = picked.reduce((n, f) => n + (ws.data?.items.find((x) => x.path === f.path)?.size ?? 0), 0);
  const toggle = (kind: keyof Choices, item: PreviewItem) => setChoices((c) => choicesAfterToggle(c, preview?.items, kind, item.id));

  if (result)
    return (
      <Stack spacing={1.5} aria-live="polite">
        <Alert severity={result.status === 'published' ? 'success' : 'info'}>
          {result.status === 'published'
            ? t('profiles.tplPub.published', { name: result.name, version: result.version })
            : t('profiles.tplPub.pendingReview', { name: result.name, version: result.version })}
        </Alert>
        {result.warnings.map((w) => (
          <Alert key={w.message} severity="warning">
            {w.message}
          </Alert>
        ))}
        <MineList mine={mine.data} labels={labels} onTakeDown={takeDown} />
      </Stack>
    );

  return (
    <Stack spacing={1.5} data-template-publish="">
      <FormControl>
        <FormLabel id="tpl-zone">{t('profiles.tplPub.zone')}</FormLabel>
        <RadioGroup aria-labelledby="tpl-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
          {(mine.data?.namespaces ?? []).map((ns) => (
            <FormControlLabel
              key={ns}
              value={ns}
              control={<Radio size="small" />}
              label={mine.data?.public.includes(ns) ? t('profiles.tplPub.zonePublic', { label: labels[ns] ?? ns }) : t('profiles.tplPub.zoneMember', { label: labels[ns] ?? ns })}
            />
          ))}
        </RadioGroup>
        {isPublic && <Alert severity="warning">{t('profiles.tplPub.publicWarn')}</Alert>}
      </FormControl>
      <TextField
        size="small"
        label={t('profiles.tplPub.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={!!name && !NAME_RE.test(name)}
        helperText={name && !NAME_RE.test(name) ? t('profiles.tplPub.nameRule') : preview?.update ? t('profiles.tplPub.bump', { from: preview.from_version, to: preview.version }) : ''}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
      <TextField
        size="small"
        multiline
        minRows={2}
        label={t('profiles.tplPub.description')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        helperText={description.trim().length < 20 ? t('profiles.tplPub.descriptionRule') : ''}
      />
      {!ready && <Typography variant="caption" color="text.secondary">{t('profiles.tplPub.fillFirst')}</Typography>}
      {previewError && <Alert severity="error">{previewError}</Alert>}
      {preview && (
        <>
          {(['skills', 'mcp', 'cron'] as const).map((kind) =>
            preview.items[kind].length ? (
              <Box key={kind} component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
                <Typography component="legend" variant="body2" sx={{ fontWeight: 600 }}>
                  {t(`profiles.tplPub.kind.${kind}`)}
                </Typography>
                {preview.items[kind].map((it) => (
                  <Box key={it.id}>
                    <FormControlLabel
                      control={<Checkbox size="small" checked={it.included} disabled={!!it.note} onChange={() => toggle(kind, it)} />}
                      label={it.label + (it.stdio ? ' · ' + t('profiles.tplPub.stdio') : '')}
                    />
                    {it.note && (
                      <Typography variant="caption" color="text.secondary" component="span">
                        {it.note}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Box>
            ) : null
          )}
          {(preview.items.agents ?? []).map((it) => (
            <FormControlLabel
              key={it.id}
              control={<Checkbox size="small" checked={it.included} onChange={(e) => setAgents(e.target.checked)} />}
              label={t('profiles.tplPub.agents', { n: it.size ?? 0 })}
            />
          ))}
          <Box component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
            <Typography component="legend" variant="body2" sx={{ fontWeight: 600 }}>
              {t('profiles.tplPub.files', { n: picked.length, max: ws.data?.max_files ?? 30, size: fmtSize(pickedBytes), maxSize: fmtSize(ws.data?.max_bytes ?? 10 * 1024 * 1024) })}
            </Typography>
            {!ws.data?.items.length && <Typography variant="caption" color="text.secondary">{t('profiles.tplPub.noFiles')}</Typography>}
            <Box sx={{ maxHeight: 240, overflow: 'auto' }}>
              {(ws.data?.items ?? []).map((f) => {
                const on = picked.find((x) => x.path === f.path);
                const info = fileInfo.get(f.path);
                return (
                  <Box key={f.path}>
                    <FormControlLabel
                      control={<Checkbox size="small" checked={!!on} onChange={() => setPicked((l) => togglePick(l, f.path, ws.data?.max_files ?? 30))} />}
                      label={`${f.path} · ${fmtSize(f.size)}`}
                    />
                    {on && info?.text && info.included && (
                      <Typography variant="caption" color="text.secondary" component="span">
                        {t('profiles.tplPub.fileAutoChecked')}
                      </Typography>
                    )}
                    {on && (needs.includes(f.path) || (info && !info.text)) && (
                      <FormControlLabel
                        sx={{ ml: 3, display: 'flex' }}
                        control={<Checkbox size="small" checked={on.confirmed} onChange={(e) => setPicked((l) => setConfirmed(l, f.path, e.target.checked))} />}
                        label={t('profiles.tplPub.fileConfirm')}
                      />
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
          <TextField
            size="small"
            multiline
            minRows={2}
            label={t('profiles.tplPub.examples')}
            value={examples}
            onChange={(e) => setExamples(e.target.value)}
            helperText={t('profiles.tplPub.examplesNote')}
          />
          <TextField
            size="small"
            multiline
            minRows={4}
            maxRows={14}
            label={t('profiles.tplPub.soul')}
            value={soul ?? preview.soul}
            onChange={(e) => setSoul(e.target.value)}
            helperText={t('profiles.tplPub.soulNote')}
          />
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t('profiles.tplPub.keys')}
            </Typography>
            {preview.env_requires.length ? (
              <Stack spacing={1} sx={{ mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t('profiles.tplPub.keyNotesNote')}
                </Typography>
                {preview.env_requires.map((e) => (
                  <TextField
                    key={e.name}
                    size="small"
                    label={t('profiles.tplPub.keyNoteLabel', { name: e.name })}
                    value={keyNotes[e.name] ?? ''}
                    // 적지 않으면 서버가 찾은 설명(SKILL.md·알려진 KEY)을 그대로 쓴다 — 그 글을 자리 표시로 보인다
                    placeholder={keyNotes[e.name] ? undefined : e.description || undefined}
                    onChange={(ev) => setKeyNotes({ ...keyNotes, [e.name]: ev.target.value })}
                    slotProps={{ htmlInput: { maxLength: 200 } }}
                  />
                ))}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {t('profiles.tplPub.noKeys')}
              </Typography>
            )}
            {preview.hub_skills.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                {t('profiles.tplPub.hubSkills', { names: preview.hub_skills.map((h) => `${h.name} ${h.version}`).join(', ') })}
              </Typography>
            )}
          </Box>
          {errors.map((e) => (
            <Alert key={e.code + e.message} severity="error">
              {e.message}
            </Alert>
          ))}
          {preview.warnings.map((w) => (
            <Alert key={w.code + w.message} severity="warning">
              {w.message}
            </Alert>
          ))}
          {internalAsk && (
            <FormControlLabel
              control={<Checkbox size="small" checked={allowInternal} onChange={(e) => setAllowInternal(e.target.checked)} />}
              label={t('profiles.tplPub.allowInternal')}
            />
          )}
        </>
      )}
      {publishError && <Alert severity="error">{publishError}</Alert>}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Button variant="contained" disabled={!ready || !preview || checking || busy || errors.length > 0 || needs.length > 0} onClick={() => void publish()}>
          {busy ? <CircularProgress size={18} /> : preview?.update ? t('profiles.tplPub.publishBump', { to: preview.version }) : t('profiles.tplPub.publish')}
        </Button>
        {checking && <CircularProgress size={16} aria-label={t('profiles.tplPub.checking')} />}
        {mine.data && (
          <Typography variant="caption" color="text.secondary">
            {t('profiles.tplPub.used', { used: mine.data.used, limit: mine.data.limit })}
          </Typography>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('profiles.tplPub.leftOut')}
      </Typography>
      <MineList mine={mine.data} labels={labels} onTakeDown={takeDown} />
    </Stack>
  );
}

function MineList({ mine, labels, onTakeDown }: { mine?: Mine; labels: Record<string, string>; onTakeDown: (name: string) => void }) {
  if (!mine?.items.length) return null;
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {t('profiles.tplPub.mine')}
      </Typography>
      <Stack component="ul" spacing={0.5} sx={{ pl: 0, m: 0, listStyle: 'none' }}>
        {mine.items.map((m) => (
          <Box component="li" key={m.name} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1 }} color={m.status === 'hidden' ? 'text.secondary' : undefined}>
              {m.name} {m.version} · {labels[m.namespace] ?? m.namespace}
            </Typography>
            {/* 허브에서 내린 것은 「내림」만 보인다 — 다시 내릴 것이 없다. 같은 이름으로 다시 올리면 새 판으로 올라간다 */}
            {m.status === 'hidden' ? (
              <Tag>{t('profiles.tplPub.takenDown')}</Tag>
            ) : (
              <Button size="small" color="inherit" variant="outlined" onClick={() => onTakeDown(m.name)}>
                {t('profiles.tplPub.takeDown')}
              </Button>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
