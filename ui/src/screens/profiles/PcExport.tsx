/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「내 PC 로 내보내기」 결과 서랍(OMAI-1136, 스펙 import-local-hermes-into-main §10-3·§5-2).
// 내려받기 단추 → 경고 한 줄 → OS 별 PC 적용 단계. 묶음은 한 번만 받을 수 있어(다 받으면 서버가 지운다) 누른 뒤에는 단추를 막고
// 「다시 내보내기」를 보인다. 받기는 브라우저가 디스크로 받게 a[href] 로 한다(메모리에 올리지 않는다).
// main 이 아닌 프로파일이면 PC 에 새 이름으로 넣는 명령이 기본이고(이름 칸 기본값 {name}-aas), 기존 프로파일 바꾸기와
// default 에 넣기는 접어 둔다(OMAI-1444 DD11·R13). main 은 지금처럼 default 에 넣는 절차다.
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { ReactNode, useState } from 'react';

import { tier1, tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { humanSize } from '@/lib/chatFiles';

import { OsTabs, Steps, tall } from './PcCommand';
import { applyCommands, detectOs, exportMain, exportUrl, importCommands, type Os, PcError, replaceCommands, type SharedSkills } from './pcImportApi';

export interface Exported {
  id: string;
  size: number;
  profile: string;
  /** 묶음에 들어가지 않는 공용 스킬(OMAI-1444 R16) */
  shared_skills?: SharedSkills;
}

/** PC 에 만들 프로파일 이름 칸 값. Hermes 프로파일 이름 규칙(소문자·숫자·_-)만 남기고, 비면 기본값 */
export const pcNewName = (raw: string, fallback: string): string => raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || fallback;

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="body2">{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  );
}

/** 서버가 붙이는 내려받기 파일 이름(hermes-<프로파일>-<UTC 날짜>.tar.gz). 적용 명령에 쓴다 */
export const exportFileName = (profile: string, now = new Date()) => `hermes-${profile}-${now.toISOString().slice(0, 10)}.tar.gz`;

export function PcExport({ pod, initial, main = true }: { pod: string; initial: Exported; /** main 내보내기인가(지금 절차 그대로) */ main?: boolean }) {
  const [cur, setCur] = useState(initial);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [os, setOs] = useState<Os>(() => detectOs());
  const [raw, setRaw] = useState(`${initial.profile}-aas`);
  const file = exportFileName(cur.profile);
  const c = applyCommands(os, file);
  const newName = pcNewName(raw, `${cur.profile}-aas`);
  const ni = importCommands(os, file, newName);
  const rc = replaceCommands(os, file, cur.profile);
  const shared = cur.shared_skills ?? initial.shared_skills;
  const again = async () => {
    setBusy(true);
    setErr('');
    try {
      setCur(await exportMain(pod, cur.profile));
      setTaken(false);
    } catch (e) {
      setErr((e as PcError).message);
    } finally {
      setBusy(false);
    }
  };
  const first = t('profiles.pcExport.firstStep');
  // PC 의 default 에 넣는 절차(§5-2). main 은 이것이 기본, 다른 프로파일은 접힌 「default 에 넣으려면」 안(DD11)
  const defaultSteps = (
    <Stack spacing={2}>
      <Steps
        steps={[
          { text: t('profiles.pcExport.apply1'), mark: first },
          { text: t('profiles.pcExport.apply2'), cmd: c.backup, mark: first },
          { text: t('profiles.pcExport.apply2a'), cmd: c.clean },
          { text: t('profiles.pcExport.apply3'), cmd: c.unpack },
          { text: t('profiles.pcExport.apply4'), cmd: c.cron },
          { text: t('profiles.pcExport.apply5'), cmd: c.check },
          { text: t('profiles.pcExport.apply6') },
        ]}
      />
      <Typography variant="caption" color="text.secondary">
        {t('profiles.pcExport.applyNote')}
      </Typography>
    </Stack>
  );
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
        <Button
          variant="outlined"
          color="inherit"
          sx={tall(tier1)}
          component="a"
          href={exportUrl(pod, cur.id)}
          download
          disabled={taken}
          startIcon={<FileDownloadOutlinedIcon />}
          // 단추를 막는 것은 브라우저가 받기를 시작한 뒤에 한다
          onClick={() => setTimeout(() => setTaken(true), 0)}
        >
          {t('profiles.pcExport.download', { size: humanSize(cur.size) })}
        </Button>
        <Typography variant="body2" color="text.secondary">
          {t('profiles.pcExport.once')}
        </Typography>
        {taken && (
          <Button
            variant="outlined"
            color="inherit"
            sx={tall(tier2)}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
            onClick={() => void again()}
          >
            {t('profiles.pcExport.again')}
          </Button>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {t('profiles.pcExport.contains')}
      </Typography>
      {/* 다른 프로파일의 스킬을 보는 설정(skills.external_dirs)은 그 스킬을 묶음에 담지 않는다(R16) */}
      {(shared?.n ?? 0) > 0 && (
        <Typography variant="body2">{t('profiles.pcExport.sharedSkills', { n: shared?.n ?? 0, name: (shared?.sources ?? []).join(', ') })}</Typography>
      )}
      {err && (
        <Alert severity="error" role="status">
          {err}
        </Alert>
      )}
      <Box>
        <Typography variant="subtitle2" component="h2" sx={{ mb: 1 }}>
          {t(main ? 'profiles.pcExport.applyTitle' : 'profiles.pcExport.applyTitleNamed')}
        </Typography>
        <OsTabs value={os} onChange={setOs} />
      </Box>
      {main ? (
        defaultSteps
      ) : (
        <>
          <TextField
            size="small"
            label={t('profiles.pcExport.newName')}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            slotProps={{ htmlInput: { spellCheck: false, autoComplete: 'off' } }}
            sx={{ maxWidth: 320 }}
          />
          <Steps
            steps={[
              { text: t('profiles.pcExport.named1'), cmd: ni.import },
              { text: t('profiles.pcExport.named2'), cmd: ni.cron },
              { text: t('profiles.pcExport.named3'), cmd: ni.check },
            ]}
          />
          <Typography variant="caption" color="text.secondary">
            {t('profiles.pcExport.namedNote')}
          </Typography>
          <Box>
            <Fold title={t('profiles.pcExport.replaceTitle')}>
              <Steps
                steps={[
                  { text: t('profiles.pcExport.replace1', { name: cur.profile }), cmd: rc.backup, mark: first },
                  { text: t('profiles.pcExport.replace2', { name: cur.profile }), cmd: rc.remove },
                  { text: t('profiles.pcExport.replace3'), cmd: rc.import },
                ]}
              />
            </Fold>
            <Fold title={t('profiles.pcExport.defaultTitle')}>{defaultSteps}</Fold>
          </Box>
        </>
      )}
    </Stack>
  );
}
