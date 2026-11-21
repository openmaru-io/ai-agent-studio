/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 만들기 창의 「템플릿에서」 탭(스펙 2026-11-18-002 §4-2·§4-4).
// ① 고르기 → ② 확인(담긴 것·MCP 주소·stdio 동의) → ③ 이름 + KEY → ④ 진행 → 결과.
// KEY 값은 서버에 맡기지 않는다: 이 화면이 들고 있다가 설치 요청이 done 이 되면 env_set 을 KEY 마다 부른다(R4).
// MCP 켜기는 서버가 env_set 뒤에 한다(E8). 10분이 지나거나 창을 닫으면 값은 버리고 「확인할 것」에서 다시 넣는다.

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Skeleton,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { useUi } from '@/components/UiContext';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { useIsAdmin } from '@/lib/data';
import { MONO_FONT } from '@/lib/monoFont';

import { SecretField } from './McpServers';
import {
  consentReady,
  consentsOf,
  defaultName,
  keyGroups,
  keysReady,
  laterMcpCount,
  phaseOf,
  POLL_MS,
  PROFILE_RE,
  refusalStep,
  type RequestRow,
  type TemplateCard,
  type TemplateDetail,
  timedOut,
} from './templateInstallState';

type StepId = 'pick' | 'confirm' | 'keys' | 'result';
const STEPS: StepId[] = ['pick', 'confirm', 'keys', 'result'];

interface Listing {
  items: TemplateCard[];
  failed: number;
  error: string;
  limit: number;
  used: number | null;
  profiles: string[];
}

/** 서랍 id — 닫을 때 「넣은 KEY 는 저장되지 않습니다」를 묻는 데 쓴다. */
export const CREATE_DRAWER_ID = 'profile-create';

export function TemplateInstall({
  onDone,
  preselect,
}: {
  onDone: (name: string) => void;
  /** 스킬 허브 서랍에서 온 템플릿 id(ns/name). 목록을 받으면 한 번 고른다. 없거나 허용되지 않았으면 목록을 그대로 보인다(스펙 2026-11-18-014) */
  preselect?: string;
}) {
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { setCloseGuard } = useUi();
  const [step, setStep] = useState<StepId>('pick');
  const [chosen, setChosen] = useState<TemplateCard | null>(null);
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [later, setLater] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const [nameError, setNameError] = useState('');
  const [limitError, setLimitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [keyErrors, setKeyErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<'' | 'done' | 'failed' | 'timeout' | 'keys_dropped'>('');
  const [mcpOn, setMcpOn] = useState<string[]>([]);
  const started = useRef(0);

  const list = useQuery<Listing>({ queryKey: ['market-templates'], queryFn: () => get('/api/market/templates'), retry: false });
  const detail = useQuery<TemplateDetail>({
    queryKey: ['market-template', chosen?.id, chosen?.version],
    queryFn: () => get(`/api/market/template?ns=${encodeURIComponent(chosen!.namespace)}&name=${encodeURIComponent(chosen!.name)}&version=${encodeURIComponent(chosen!.version)}`),
    enabled: !!chosen,
    retry: false,
  });
  const d = detail.data;
  const groups = d ? keyGroups(d) : [];
  const holding = Object.values(values).some((v) => v.trim()) && outcome === '';

  // 넣은 KEY 를 들고 있는 동안 창을 닫거나 다른 곳으로 가려 하면 묻는다(디자인 리뷰)
  useEffect(() => {
    if (!holding) {
      setCloseGuard(CREATE_DRAWER_ID, null);
      return;
    }
    setCloseGuard(CREATE_DRAWER_ID, () => confirm(t('profiles.tpl.leaveConfirm'), { title: t('profiles.tpl.leaveTitle'), danger: true }));
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      setCloseGuard(CREATE_DRAWER_ID, null);
    };
  }, [holding, confirm, setCloseGuard]);

  const pick = (c: TemplateCard) => {
    setChosen(c);
    setAgreed({});
    setName(defaultName(c.name, list.data?.profiles ?? []));
    setNotice('');
    setStep('confirm');
  };

  const preselected = useRef(false);
  useEffect(() => {
    if (!preselect || preselected.current || !list.data) return;
    preselected.current = true;
    const c = list.data.items.find((x) => x.id === preselect);
    if (c && c.allowed !== false) pick(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect, list.data]);

  const putKeys = async (profile: string) => {
    const errors: Record<string, string> = {};
    let enabled: string[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!value || later[key]) continue;
      try {
        const r = await post<{ mcp_enabled?: string[] }>('/api/profile/action', { name: profile, action: 'env_set', target: key, value });
        if (r.mcp_enabled) enabled = [...enabled, ...r.mcp_enabled];
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // 다시 로그인하면 들고 있던 값을 잃는다 — 값을 버리고 「확인할 것」으로 보낸다(E20)
          setValues({});
          setOutcome('keys_dropped');
          return;
        }
        errors[key] = (e as Error).message;
      }
    }
    setKeyErrors(errors);
    setMcpOn(enabled);
    setValues({});
    setOutcome('done');
  };

  // ④ 3초마다 요청 상태를 읽는다. done 이면 곧바로 KEY 를 넣는다(마무리를 기다리지 않는다)
  useEffect(() => {
    if (step !== 'result' || !request || outcome) return;
    const timer = window.setInterval(async () => {
      if (timedOut(started.current, Date.now())) {
        setValues({});
        setOutcome('timeout');
        return;
      }
      try {
        const r = await get<RequestRow & { profile?: string }>(`/api/market/request?id=${encodeURIComponent(request.id)}`);
        setRequest(r);
        const ph = phaseOf(r);
        if (ph === 'created') {
          window.clearInterval(timer);
          void qc.invalidateQueries({ queryKey: ['profiles'] });
          await putKeys(name);
        } else if (ph === 'failed' || ph === 'needs') {
          window.clearInterval(timer);
          const back = refusalStep(r.code);
          if (back === 'confirm') {
            setNotice(t('profiles.tpl.changed'));
            setAgreed({});
            void detail.refetch();
            setRequest(null);
            setStep('confirm');
          } else if (back === 'pick') {
            setNotice(t('profiles.tpl.takenDown'));
            setRequest(null);
            setStep('pick');
          } else {
            setValues({});
            setOutcome('failed');
          }
        }
      } catch {
        /* 잠깐 닿지 않으면 다음 주기에 다시 읽는다 */
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, request?.id, outcome]);

  const create = async () => {
    if (!chosen || !d) return;
    setBusy(true);
    setNameError('');
    setLimitError('');
    try {
      const r = await post<{ request: RequestRow }>('/api/market/install', {
        namespace: chosen.namespace,
        name: chosen.name,
        version: chosen.version,
        profile: name.trim(),
        mode: 'install',
        consents: consentsOf(d.mcp),
      });
      started.current = Date.now();
      setRequest(r.request);
      setOutcome('');
      setStep('result');
    } catch (e) {
      const reason = e instanceof ApiError ? e.reason : '';
      if (reason === 'name_taken') {
        setNameError(t('profiles.tpl.nameTaken'));
        setStep('confirm');                                   // 이름 칸은 ② 에 있다
      }
      else if (reason === 'profile_limit') setLimitError(t('profiles.tpl.limit', { used: list.data?.used ?? 0, max: list.data?.limit ?? 0 }));
      else if (reason === 'pending') setLimitError(t('profiles.tpl.pending'));
      else if (reason === 'hidden') {
        setNotice(t('profiles.tpl.takenDown'));
        setStep('pick');
        void list.refetch();
      } else setLimitError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = STEPS.indexOf(step);
  const header = narrow ? (
    <Typography variant="body2" color="text.secondary" aria-live="polite">
      {t('profiles.tpl.stepShort', { n: stepIndex + 1, label: t(`profiles.tpl.step.${step}`) })}
    </Typography>
  ) : (
    <Stepper activeStep={stepIndex} alternativeLabel>
      {STEPS.map((s, i) => (
        <Step key={s} completed={i < stepIndex}>
          <StepLabel slotProps={{ label: { 'aria-current': i === stepIndex ? 'step' : undefined } as never }}>{t(`profiles.tpl.step.${s}`)}</StepLabel>
        </Step>
      ))}
    </Stepper>
  );

  return (
    <Stack spacing={1.5} data-template-install="">
      {header}
      {notice && (
        <Alert severity="info" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {step === 'pick' && (
        <PickStep list={list} onPick={pick} />
      )}

      {step === 'confirm' && chosen && (
        <Stack spacing={1.5}>
          {detail.isLoading && <Skeleton variant="rounded" height={160} />}
          {detail.error && <Alert severity="error">{(detail.error as Error).message}</Alert>}
          {d && (
            <>
              {/* 무엇을 받는지(템플릿)와 무엇이 생기는지(새 프로파일 이름)를 한 덩어리로. 이름은 여기서 정한다(2026-11-18 사용자 요청) */}
              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="baseline" useFlexGap flexWrap="wrap">
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {d.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {d.version}
                  </Typography>
                </Stack>
                {d.description && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    {d.description}
                  </Typography>
                )}
                <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }} aria-label={t('profiles.tpl.contents', { skills: d.skills + d.hub_skills.length, mcp: d.mcp.length, cron: d.cron.length, files: d.files.length })}>
                  <Tag>{t('profiles.tpl.countSkills', { n: d.skills + d.hub_skills.length })}</Tag>
                  <Tag>{t('profiles.tpl.countMcp', { n: d.mcp.length })}</Tag>
                  <Tag>{t('profiles.tpl.countCron', { n: d.cron.length })}</Tag>
                  <Tag>{t('profiles.tpl.countFiles', { n: d.files.length })}</Tag>
                  {d.agents && <Tag>{t('profiles.tpl.countAgents')}</Tag>}
                </Stack>
                <TextField
                  size="small"
                  fullWidth
                  sx={{ mt: 2 }}
                  label={t('profiles.tpl.newName')}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError('');
                  }}
                  error={!!nameError || (!!name && !PROFILE_RE.test(name))}
                  helperText={nameError || (name && !PROFILE_RE.test(name) ? t('profiles.tpl.nameRule') : t('profiles.tpl.nameHint'))}
                  slotProps={{ htmlInput: { spellCheck: false } }}
                />
              </Box>
              {d.model_hint && (
                <Typography variant="caption" color="text.secondary">
                  {t('profiles.tpl.modelHint', { model: d.model_hint })}
                </Typography>
              )}
              {d.mcp.length > 0 && (
                // MCP 는 카드 여러 장 대신 한 목록의 줄로. 앞 아이콘이 종류(명령 실행 / 주소 연결)를 알린다
                <Box component="ul" sx={{ pl: 0, m: 0, listStyle: 'none', border: 1, borderColor: 'divider', borderRadius: 1 }}>
                  {d.mcp.map((m, i) => (
                    <Box component="li" key={m.name} sx={{ px: 1.5, py: 1, borderTop: i ? 1 : 0, borderColor: 'divider' }}>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        {m.stdio ? <TerminalOutlinedIcon sx={{ fontSize: 16 }} aria-hidden /> : <LinkOutlinedIcon sx={{ fontSize: 16 }} aria-hidden />}
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {t('profiles.tpl.mcpRow', { name: m.name })}
                        </Typography>
                      </Stack>
                      {m.stdio ? (
                        <>
                          <Box component="pre" sx={{ fontFamily: MONO_FONT, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', m: 0, mt: 0.5 }}>
                            {[m.command, ...(m.args ?? [])].join(' ')}
                          </Box>
                          {m.problem ? (
                            <Alert severity="error" sx={{ mt: 0.5 }}>
                              {m.problem}
                            </Alert>
                          ) : (
                            <FormControlLabel
                              control={<Checkbox checked={!!agreed[m.name]} onChange={(e) => setAgreed({ ...agreed, [m.name]: e.target.checked })} />}
                              label={t('profiles.tpl.consent')}
                            />
                          )}
                        </>
                      ) : (
                        <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12, wordBreak: 'break-all' }}>
                          {m.url}
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
              <Source title={t('profiles.tpl.soul')} text={d.soul} />
              {d.agents && <Source title={t('profiles.tpl.agents')} text={d.agents} />}
              {d.cron.length > 0 && (
                <Source
                  title={t('profiles.tpl.cronSource', { n: d.cron.length })}
                  text={d.cron.map((c) => `# ${c.name} (${c.schedule})\n${c.prompt}${c.script ? `\n[script]\n${c.script}` : ''}`).join('\n\n')}
                />
              )}
              <Typography variant="caption" color="text.secondary">
                {t('profiles.tpl.injectionNote')}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button variant="outlined" color="inherit" onClick={() => setStep('pick')}>
                  {t('profiles.tpl.back')}
                </Button>
                <Button variant="contained" disabled={!consentReady(d.mcp, agreed) || !PROFILE_RE.test(name)} onClick={() => setStep('keys')}>
                  {t('profiles.tpl.next')}
                </Button>
              </Box>
            </>
          )}
        </Stack>
      )}

      {step === 'keys' && d && (
        <Stack spacing={1.5}>
          {/* 이름은 ② 에서 정했다. 여기서는 무엇을 만드는지 다시 보이고 고칠 길을 둔다 */}
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Typography variant="body2" color="text.secondary">
              {t('profiles.tpl.newName')}
            </Typography>
            <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontWeight: 600 }} data-testid="tpl-new-name">
              {name}
            </Typography>
            <Button size="small" color="inherit" onClick={() => setStep('confirm')}>
              {t('profiles.tpl.changeName')}
            </Button>
          </Stack>
          {groups.length === 0 && <Typography variant="body2">{t('profiles.tpl.noKeys')}</Typography>}
          {groups.map((g) => (
            <Stack key={`${g.kind}:${g.label}`} spacing={1} component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
              <Typography component="legend" variant="body2" sx={{ fontWeight: 600 }}>
                {g.kind === 'mcp' ? t('profiles.tpl.groupMcp', { name: g.label }) : g.kind === 'skill' ? t('profiles.tpl.groupSkill', { name: g.label }) : t('profiles.tpl.groupOther')}
              </Typography>
              {g.fields.map((f) => (
                <Box key={f.name}>
                  <SecretField
                    label={f.name}
                    required={f.required && !later[f.name]}
                    helper={keyErrors[f.name] || f.description}
                    error={keyErrors[f.name]}
                    value={values[f.name] ?? ''}
                    onChange={(v) => setValues({ ...values, [f.name]: v })}
                    // 「나중에 넣기」를 고르면 칸을 막는다 — 넣은 값을 쓰는지 버리는지 헷갈리지 않게(OKE my-template, 2026-11-18)
                    disabled={!!later[f.name]}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={!!later[f.name]}
                        onChange={(e) => {
                          setLater({ ...later, [f.name]: e.target.checked });
                          if (e.target.checked) setValues({ ...values, [f.name]: '' });
                        }}
                        // 체크 상자가 KEY 마다 있어 접근 이름에 KEY 이름을 붙인다(화면 읽기 프로그램이 구별하게)
                        slotProps={{ input: { 'aria-label': t('profiles.tpl.laterFor', { name: f.name }) } }}
                      />
                    }
                    label={t('profiles.tpl.later')}
                  />
                </Box>
              ))}
            </Stack>
          ))}
          {limitError && <Alert severity="warning">{limitError}</Alert>}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="outlined" color="inherit" onClick={() => setStep('confirm')}>
              {t('profiles.tpl.back')}
            </Button>
            <Button variant="contained" disabled={busy || !PROFILE_RE.test(name) || !keysReady(groups, values, later)} onClick={() => void create()}>
              {busy ? <CircularProgress size={18} /> : t('profiles.tpl.create')}
            </Button>
          </Box>
          {laterMcpCount(d.mcp, values) > 0 && (
            <Typography variant="caption" color="text.secondary">
              {t('profiles.tpl.laterNote', { count: laterMcpCount(d.mcp, values) })}
            </Typography>
          )}
        </Stack>
      )}

      {step === 'result' && (
        <ResultStep
          request={request}
          outcome={outcome}
          keyErrors={keyErrors}
          mcpOn={mcpOn}
          missing={d ? d.env_requires.filter((e) => later[e.name] || keyErrors[e.name] || outcome === 'timeout' || outcome === 'keys_dropped').map((e) => e.name) : []}
          cron={d?.cron.length ?? 0}
          examples={d?.examples ?? []}
          onOpen={() => onDone(name)}
        />
      )}
    </Stack>
  );
}

/** 허용이 필요한 구역이라 이 작업공간이 받을 수 없는 카드의 아래 줄(스펙 2026-11-18-015 §3-4). 카드는 꺼진 단추라 그 안에 링크·단추를 둘 수 없다.
 *  관리자: 「이 작업공간에 허용」(서랍 자물쇠와 같은 /api/market/grant, 확인 창)·「제한 스킬·템플릿 설치 허용」 링크. 그 밖의 사람: 안내와 「관리자에게 허용 요청」(X2) */
function NotAllowedRow({ c, onAllowed }: { c: TemplateCard; onAllowed: () => void }) {
  const admin = useIsAdmin();
  const confirm = useConfirm();
  const { closeDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const ns = c.namespace_label || c.namespace;
  const allow = async () => {
    if (!(await confirm(t('market.grantAllowConfirm', { ns }), { title: t('market.grants.allowHere'), confirmLabel: t('market.grants.allowHere') }))) return;
    setBusy(true);
    try {
      await post('/api/market/grant', { namespace: c.namespace, allow: true });
      enqueueSnackbar(t('market.grants.allowHereDone', { ns }), { variant: 'success' });
      onAllowed();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5, px: 0.5 }} data-not-allowed={c.id}>
      <Typography variant="caption" color="warning.main" sx={{ flexBasis: '100%' }}>
        {admin ? t('profiles.tpl.notAllowed') : t('market.paidNotAllowedAsk', { ns })}
      </Typography>
      {admin ? (
        <>
          <Button size="small" variant="outlined" disabled={busy} onClick={() => void allow()}>
            {t('market.grants.allowHere')}
          </Button>
          <Link to="/market?tab=grants" onClick={() => closeDrawer()}>
            {t('market.grants.goto')}
          </Link>
        </>
      ) : (
        <RequestAdminButton profile="_workspace" kind="namespace_grant" namespace={c.namespace} label={t('market.grants.askAdmin')} />
      )}
    </Stack>
  );
}

function PickStep({ list, onPick }: { list: { data?: Listing; isLoading: boolean; error: unknown; refetch: () => unknown }; onPick: (c: TemplateCard) => void }) {
  if (list.isLoading)
    return (
      <Stack spacing={1} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={84} />
        ))}
      </Stack>
    );
  const error = (list.error as Error | null)?.message || list.data?.error;
  if (error)
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void list.refetch()}>
            {t('profiles.tpl.retry')}
          </Button>
        }
      >
        {error}
      </Alert>
    );
  const items = list.data?.items ?? [];
  if (!items.length)
    return (
      <Stack spacing={0.5}>
        <Typography variant="body2">{t('profiles.tpl.empty')}</Typography>
        <Typography variant="caption" color="text.secondary">
          {t('profiles.tpl.emptyHow')}
        </Typography>
      </Stack>
    );
  return (
    <Stack spacing={1} component="ul" sx={{ pl: 0, m: 0, listStyle: 'none' }}>
      {items.map((c) => (
        <Box component="li" key={c.id}>
          <Button
            fullWidth
            variant="outlined"
            color="inherit"
            disabled={c.allowed === false}
            onClick={() => onPick(c)}
            sx={{ justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none', display: 'block', p: 1.25 }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {c.name} <Typography component="span" variant="caption" color="text.secondary">{c.version}</Typography>
            </Typography>
            {(c.description || c.summary) && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {c.description || c.summary}
              </Typography>
            )}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
              {(c.tags ?? []).slice(0, 3).map((tag) => (
                <Chip key={tag} size="small" label={tag} />
              ))}
              {c.env_requires.length > 0 && <Chip size="small" variant="outlined" label={t('profiles.tpl.keysNeeded', { count: c.env_requires.length })} />}
              {c.mcp.some((m) => m.stdio) && <Chip size="small" variant="outlined" color="warning" label={t('profiles.tpl.hasStdio')} />}
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                {t('profiles.tpl.byAndInstalls', { author: c.author || c.owner || '-', n: c.installs ?? 0 })}
              </Typography>
            </Box>
          </Button>
          {c.allowed === false && <NotAllowedRow c={c} onAllowed={() => void list.refetch()} />}
        </Box>
      ))}
    </Stack>
  );
}

function Source({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <Accordion disableGutters variant="outlined">
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="body2">{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box component="pre" sx={{ fontFamily: MONO_FONT, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', m: 0, maxHeight: 320, overflow: 'auto' }}>
          {text}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}

function ResultStep({
  request,
  outcome,
  keyErrors,
  mcpOn,
  missing,
  cron,
  examples,
  onOpen,
}: {
  request: RequestRow | null;
  outcome: string;
  keyErrors: Record<string, string>;
  mcpOn: string[];
  missing: string[];
  cron: number;
  examples: string[];
  onOpen: () => void;
}) {
  const phase = phaseOf(request ?? undefined);
  if (!outcome)
    return (
      <Stack spacing={1} aria-live="polite">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">{phase === 'created' ? t('profiles.tpl.puttingKeys') : t('profiles.tpl.waiting')}</Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t('profiles.tpl.waitingNote')}
        </Typography>
      </Stack>
    );
  if (outcome === 'failed')
    return (
      <Alert severity="error" aria-live="polite">
        {t('profiles.tpl.failed', { message: request?.message ?? '' })}
      </Alert>
    );
  return (
    <Stack spacing={1} aria-live="polite">
      {outcome === 'timeout' ? (
        <Alert severity="warning">{t('profiles.tpl.timeout')}</Alert>
      ) : outcome === 'keys_dropped' ? (
        <Alert severity="warning">{t('profiles.tpl.keysDropped')}</Alert>
      ) : (
        <Alert severity="success">{t('profiles.tpl.created')}</Alert>
      )}
      {mcpOn.length > 0 && <Typography variant="body2">{t('profiles.tpl.mcpOn', { names: mcpOn.join(', ') })}</Typography>}
      {missing.length > 0 && <Typography variant="body2">{t('profiles.tpl.missingKeys', { names: missing.join(', ') })}</Typography>}
      {Object.keys(keyErrors).length > 0 && <Typography variant="body2" color="error">{t('profiles.tpl.keyFailed', { names: Object.keys(keyErrors).join(', ') })}</Typography>}
      {cron > 0 && <Typography variant="body2">{t('profiles.tpl.cronOff', { count: cron })}</Typography>}
      {examples.length > 0 && (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {t('profiles.tpl.firstTask')}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {examples.map((x) => (
              <Typography component="li" variant="body2" key={x}>
                {x}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
      {outcome !== 'timeout' && (
        <Box>
          <Button variant="contained" onClick={onOpen}>
            {t('profiles.tpl.open')}
          </Button>
        </Box>
      )}
    </Stack>
  );
}
