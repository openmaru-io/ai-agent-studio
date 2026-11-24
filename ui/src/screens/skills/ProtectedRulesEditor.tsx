/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 보호 스킬의 「설치 규칙」(cogentai-aas-docs 스펙 2026-11-24-001 6절). 새 편집기를 만들지 않고 TextEditor 에 잇는 연결층이다.
// 사람이 쓴 규칙은 서버가 그 프로파일의 사본 SKILL.md 끝 절로 붙이고(리더 주기, 60초 안), 에이전트의 수정은 되돌린다.
//
//   스킬 상세의 보호 스킬 안내 ── [설치 규칙] ──▶ 대화상자
//     머리 줄(원본 판 · 규칙 판 · 반영 상태) → 경고 띠 → 안내 한 줄 → 접힌 「바꿀 수 없는 것」 → TextEditor → [사본 끝 모양 보기] [규칙 지우기]
import ExpandMore from '@mui/icons-material/ExpandMore';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Skeleton,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { Pill } from '@/components/DataGrid';
import { TextEditor, type VersionInfo } from '@/components/TextEditor';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { fmtTs } from '@/lib/format';
import { lineDiff } from '@/lib/mdtools';
import { MONO_FONT } from '@/lib/monoFont';
import { checkRulesText, rulesApi, type RulesPreview } from '@/lib/protectedRules';

export interface ProtectedRulesProps {
  profile: string;
  skill: string;
}

/** 스킬 상세에 두는 단추 + 대화상자. 단추 이름(쓰기 · 읽기)과 「규칙 판 N」은 대화상자와 같은 GET 으로 정한다 */
export function ProtectedRules({ profile, skill }: ProtectedRulesProps) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['protected-rules', profile, skill], queryFn: rulesApi(profile, skill).view, retry: false });
  const rev = q.data?.text ? q.data.rev : 0;
  const canEdit = q.data ? q.data.can_edit : undefined;
  return (
    <Box sx={{ mb: 1 }}>
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        {t('skills.rules.originNote')}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button size="small" variant="outlined" startIcon={<GavelOutlinedIcon />} onClick={() => setOpen(true)}>
          {canEdit === false ? t('skills.rules.view') : t('skills.rules.open')}
        </Button>
        {!!rev && <Pill tone="info">{t('skills.rules.pill', { rev })}</Pill>}
      </Stack>
      {open && <ProtectedRulesDialog profile={profile} skill={skill} onClose={() => setOpen(false)} />}
    </Box>
  );
}

const STATE_TONE = { pending: 'warn', applied: 'good', failed: 'bad', off: undefined } as const;

/** 서버 오류를 사람 문장으로. 422 는 검사 이름 · 줄 번호로 화면 문장을 만든다(걸린 줄의 글은 서버가 돌려주지 않는다) */
export function rulesErrorText(e: unknown, max: number): string {
  if (e instanceof ApiError && e.reason === 'invalid_text') {
    const check = String(e.data.check || '');
    const line = Number(e.data.line || 0);
    return t(`skills.rules.check.${check}`, { line, max: max.toLocaleString() });
  }
  return (e as Error).message;
}

export function ProtectedRulesDialog({ profile, skill, onClose }: { profile: string; skill: string; onClose: () => void }) {
  const api = useMemo(() => rulesApi(profile, skill), [profile, skill]);
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const key = ['protected-rules', profile, skill];
  // 저장한 판과 다시 읽기를 멈출 때. 그 판 이상이 반영될 때까지 다시 읽는다
  const [wait, setWait] = useState<{ rev: number; until: number } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [preview, setPreview] = useState<RulesPreview | null>(null);
  const [draft, setDraft] = useState('');
  const dirty = useRef(false);
  const q = useQuery({ queryKey: key, queryFn: api.view });
  const d = q.data;
  // 저장 뒤 대화상자가 열려 있는 동안, 저장한 판 이상이 반영될 때까지 poll_s 마다 다시 읽는다(최대 poll_max_s).
  // 저장 직후 화면은 아직 옛 판의 「반영됨」을 들고 있다 — 그 값으로 멈추면 다시 읽지 않아 「반영 대기」에 머물렀다(2026-11-24 로컬 실화면)
  const waiting = !!wait && !!d && (d.rev < wait.rev || d.apply_state === 'pending');
  const pollS = d?.limits.poll_s ?? 10;
  const { refetch: refetchView } = q;
  useEffect(() => {
    if (!wait || !waiting) return;
    const id = window.setInterval(() => {
      if (Date.now() <= wait.until) refetchView();
    }, pollS * 1000);
    const timer = window.setTimeout(() => setStalled(true), Math.max(0, wait.until - Date.now()));
    return () => {
      window.clearInterval(id);
      window.clearTimeout(timer);
    };
  }, [wait, waiting, pollS, refetchView]);
  useEffect(() => {
    if (wait && d && !waiting) {
      setWait(null);
      setStalled(false);
    }
  }, [wait, d, waiting]);

  const refetch = () => qc.invalidateQueries({ queryKey: key });
  const afterSave = async (saved: unknown) => {
    const rev = Number((saved as { rev?: number } | undefined)?.rev) || (d?.rev ?? 0) + 1;
    setPreview(null);
    setStalled(false);
    setWait({ rev, until: Date.now() + (d?.limits.poll_max_s ?? 120) * 1000 });
    await refetch();
  };
  const close = async () => {
    if (dirty.current && !(await confirm(t('skills.rules.closeDirty')))) return;
    onClose();
  };

  const readOnly = !d ? '' : d.clone_of ? t('skills.rules.ro.clone', { name: d.clone_of }) : !d.enabled ? t('skills.rules.ro.off') : !d.can_edit ? t('skills.rules.ro.perm') : '';
  const versions = async (): Promise<VersionInfo[]> =>
    (d?.versions ?? []).map((v) => ({
      id: v.rev,
      sha: String(v.rev),
      saved_at: v.ts,
      by: v.author,
      size: v.chars,
      note: v.chars ? v.note : [v.note, t('skills.rules.clearedTag')].filter(Boolean).join(' '),
    }));
  const textOf = async (rev: number) => (rev === d?.rev ? d.text : (await api.at(rev)).text);

  return (
    <Dialog open onClose={close} fullWidth maxWidth="md" fullScreen={narrow} aria-labelledby="protected-rules-title">
      <DialogTitle id="protected-rules-title">{t('skills.rules.title', { name: skill })}</DialogTitle>
      <DialogContent>
        {q.isLoading ? (
          <Stack spacing={1} data-testid="rules-loading">
            <Skeleton variant="text" width="60%" />
            <Skeleton variant="rectangular" height={160} />
          </Stack>
        ) : q.isError || !d ? (
          <Alert severity="error" action={<Button onClick={() => q.refetch()}>{t('skills.rules.reload')}</Button>}>
            {t('skills.rules.loadFailed')}
          </Alert>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <Typography variant="body2">{t('skills.rules.head', { source: d.source_version || '—', rev: d.rev })}</Typography>
              {!!d.rev && d.author && (
                <Typography variant="caption" color="text.secondary">
                  {t('skills.rules.headBy', { by: d.author, ts: fmtTs(d.ts) })}
                </Typography>
              )}
              <Box role="status">
                {/* 규칙을 한 번도 쓰지 않았으면(판 0) 반영 상태를 보이지 않는다 — 「반영됨(판 0)」은 뜻이 없다 */}
                {(d.rev > 0 || d.apply_state === 'off') && (
                  <Pill tone={STATE_TONE[d.apply_state]}>{t(`skills.rules.state.${d.apply_state}`, { rev: d.rev })}</Pill>
                )}
              </Box>
              {d.apply_state === 'applied' && !!d.rev && (
                <Typography variant="caption" color="text.secondary">
                  {t('skills.rules.howToCheck')}
                </Typography>
              )}
            </Stack>
            {stalled && waiting && (
              <Alert severity="warning" action={<Button onClick={() => q.refetch()}>{t('skills.rules.reload')}</Button>}>
                {t('skills.rules.stillPending')}
              </Alert>
            )}
            {!d.reads_rules && (
              <Alert severity="warning">
                {t('skills.rules.notRead')}. {t('skills.rules.notReadNext')}
              </Alert>
            )}
            {d.base_stale && (
              <Alert
                severity="info"
                action={
                  d.can_edit ? (
                    <Button
                      onClick={async () => {
                        try {
                          await api.ack(d.rev);
                          enqueueSnackbar(t('skills.rules.acked', { rev: d.rev, now: d.source_version }), { variant: 'success' });
                          await refetch();
                        } catch (e) {
                          enqueueSnackbar(rulesErrorText(e, d.limits.max_chars), { variant: 'error' });
                          await refetch();
                        }
                      }}
                    >
                      {t('skills.rules.ack')}
                    </Button>
                  ) : undefined
                }
              >
                {t('skills.rules.base', { now: d.source_version, base: d.base_version })}
              </Alert>
            )}
            {readOnly && <Alert severity="info">{readOnly}</Alert>}
            <Typography variant="caption" color="text.secondary">
              {t('skills.rules.elsewhere')}
            </Typography>
            {!!d.fixed_rules && (
              <Accordion disableGutters defaultExpanded={d.base_stale} variant="outlined">
                <AccordionSummary expandIcon={<ExpandMore />}>{t('skills.rules.fixed')}</AccordionSummary>
                <AccordionDetails>
                  <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', fontFamily: MONO_FONT, fontSize: 12 }}>
                    {d.fixed_rules}
                  </Box>
                </AccordionDetails>
              </Accordion>
            )}
            <TextEditor
              label={t('skills.rules.label')}
              mode="markdown"
              // versions: 이전 버전 수. 넘기지 않으면 TextEditor 가 「이전 버전 N」(되돌리기)을 그리지 않는다(2026-11-24 OKE 에서 찾음)
              doc={{ lines: d.text ? d.text.split('\n') : [], sha: String(d.rev), versions: Math.max(0, d.versions.length - 1) }}
              editable={!readOnly}
              whyNot={readOnly}
              hint={d.text ? undefined : t('skills.rules.placeholder')}
              draftKey={`protected-rules:${profile}:${skill}`}
              start={readOnly ? undefined : 'edit'}   // 읽기만 되면 보기로 연다 — 고치기 모드로 열면 「바뀐 줄 확인」이 보였다(2026-11-24 OKE)
              limit={{ max: d.limits.max_chars, warn: () => t('skills.rules.check.length', { max: d.limits.max_chars.toLocaleString() }) }}
              conflictText={t('skills.rules.busy')}
              savedMessage={() => t('skills.rules.saved')}
              check={async (content) => {
                setDraft(content);
                if (!content.trim() && d.text.trim()) return t('skills.rules.check.empty');
                const found = checkRulesText(content, d.limits.max_chars);
                if (found) return t(`skills.rules.check.${found[0]}`, { line: found[1], max: d.limits.max_chars.toLocaleString() });
                try {
                  setPreview(await api.preview(content));            // 비밀값 판정은 서버 미리보기(D8)
                } catch (e) {
                  return rulesErrorText(e, d.limits.max_chars);
                }
              }}
              save={async (content, sha, note) => {
                await afterSave(await api.save(content, Number(sha), note));
              }}
              reload={refetch}
              versions={versions}
              version={async (rev) => ({ lines: (await textOf(rev)).split('\n') })}
              diff={async (rev) => lineDiff(await textOf(rev), d.text)}
              revert={async (rev, sha) => {
                await afterSave(await api.restore(rev, Number(sha)));
              }}
              onDirtyChange={(v) => {
                dirty.current = v;
              }}
            />
            {preview && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  {t('skills.rules.previewNote', { rev: preview.rev })}
                </Typography>
                <Box
                  component="pre"
                  data-testid="rules-preview"
                  sx={{ m: 0, p: 1, border: 1, borderColor: 'divider', borderRadius: 1, whiteSpace: 'pre-wrap', fontFamily: MONO_FONT, fontSize: 12 }}
                >
                  <Box component="span" sx={{ color: 'text.disabled' }}>
                    {preview.source_tail + '\n'}
                  </Box>
                  {'\n' + preview.tail}
                </Box>
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {d && !readOnly && (
          <>
            <Button
              onClick={async () => {
                try {
                  setPreview(await api.preview(draft || d.text));
                } catch (e) {
                  enqueueSnackbar(rulesErrorText(e, d.limits.max_chars), { variant: 'error' });
                }
              }}
            >
              {t('skills.rules.preview')}
            </Button>
            {!!d.text && (
              <Button
                color="error"
                onClick={async () => {
                  if (!(await confirm(t('skills.rules.clearConfirm'), { title: t('skills.rules.clearAsk'), confirmLabel: t('skills.rules.clear'), danger: true }))) return;
                  try {
                    const out = await api.save('', d.rev, t('skills.rules.clearNote'));
                    enqueueSnackbar(t('skills.rules.cleared'), { variant: 'success' });
                    await afterSave(out);
                  } catch (e) {
                    enqueueSnackbar(rulesErrorText(e, d.limits.max_chars), { variant: 'error' });
                    await refetch();
                  }
                }}
              >
                {t('skills.rules.clear')}
              </Button>
            )}
          </>
        )}
        <Button onClick={close}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
