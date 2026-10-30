/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › 회사 정보 › 부서 슬로건·목표(스펙 2026-10-15-018). 부서마다 한 줄을 적고, 3D 오피스 위 현수막에 쓴다.
// 입력 칸 옆 AI 단추는 후보 3개를 받아 고른 것을 칸에 넣는다(저장은 사람이 누른다, 스펙 2026-10-17-015).
// 문구를 비워 저장하면 그 부서의 현수막이 없어진다. 관리자는 모든 부서를, 일반 사용자는 자기 부서 한 줄만 고친다(서버도 403, OMAI-1230).
import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { SloganSuggestButton } from '@/components/SloganSuggest';
import { keepCoveredGlyphs } from '@/features/office/scene3d/glyphs';
import { t } from '@/i18n';
import { post } from '@/lib/api';

export interface DepartmentGoal {
  team: string;
  goal: string;
  people: number;
}

const clean = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');

function GoalRow({ row, max, canEdit }: { row: DepartmentGoal; max: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [value, setValue] = useState(row.goal);
  const [busy, setBusy] = useState(false);
  const cleaned = clean(value);
  const changed = cleaned !== row.goal;
  const tooLong = cleaned.length > max;
  const lost = keepCoveredGlyphs(cleaned) !== cleaned; // 번들 글꼴에 없는 글자(이모지 등)는 현수막에서 빠진다
  const save = async () => {
    setBusy(true);
    try {
      await post('/api/settings/goal', { team: row.team, goal: cleaned });
      enqueueSnackbar(cleaned ? t('settings.goalSaved', { team: row.team }) : t('settings.goalCleared', { team: row.team }), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['office'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack direction="row" spacing={1} alignItems="flex-start" component="li" sx={{ listStyle: 'none' }}>
      <TextField
        size="small"
        fullWidth
        label={row.team}
        value={value}
        placeholder={t('settings.goalPlaceholder')}
        disabled={!canEdit || busy}
        error={tooLong}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && changed && !tooLong && canEdit) void save();
        }}
        helperText={
          lost
            ? t('settings.goalGlyphs', { count: cleaned.length, max })
            : t('settings.goalCount', { count: cleaned.length, max, people: row.people })
        }
      />
      {canEdit && <SloganSuggestButton team={row.team} onPick={setValue} disabled={busy} />}
      {canEdit && (
        <Button variant="contained" disabled={!changed || tooLong || busy} onClick={() => void save()} sx={{ flexShrink: 0, mt: '1px' }}>
          {t('settings.save')}
        </Button>
      )}
    </Stack>
  );
}

/** own: 일반 사용자 화면(자기 부서 한 줄만). 새 부서 추가는 관리자만 한다 */
export function DepartmentGoals({ rows, max, canEdit, own = false }: { rows: DepartmentGoal[]; max: number; canEdit: boolean; own?: boolean }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [newTeam, setNewTeam] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const add = async () => {
    try {
      await post('/api/settings/goal', { team: clean(newTeam), goal: clean(newGoal) });
      enqueueSnackbar(t('settings.goalSaved', { team: clean(newTeam) }), { variant: 'success' });
      setNewTeam('');
      setNewGoal('');
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['office'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const addable = !!clean(newTeam) && !!clean(newGoal) && clean(newGoal).length <= max;
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t(own ? 'settings.goalLeadOwn' : 'settings.goalLead', { max })}
      </Typography>
      {rows.length ? (
        <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0 }}>
          {rows.map((r) => (
            // 저장하면 목록을 다시 받는다. 문구를 키에 넣어 서버 값이 바뀌면 입력 칸도 새 값으로 시작한다
            <GoalRow key={`${r.team}|${r.goal}`} row={r} max={max} canEdit={canEdit} />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {t(own ? 'settings.goalNoDepartment' : 'settings.goalEmpty')}
        </Typography>
      )}
      {canEdit && !own && (
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 2 }}>
          <TextField size="small" label={t('settings.goalNewTeam')} value={newTeam} onChange={(e) => setNewTeam(e.target.value)} sx={{ width: 220 }} />
          <TextField
            size="small"
            fullWidth
            label={t('settings.goalNewText')}
            value={newGoal}
            onChange={(e) => setNewGoal(e.target.value)}
            helperText={t('settings.goalNewHelp')}
          />
          <SloganSuggestButton team={clean(newTeam)} onPick={setNewGoal} disabled={!clean(newTeam)} />
          <Button startIcon={<AddIcon />} variant="outlined" disabled={!addable} onClick={() => void add()} sx={{ flexShrink: 0, mt: '1px' }}>
            {t('settings.goalAdd')}
          </Button>
        </Stack>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        {t('settings.goalNote')}
      </Typography>
    </Box>
  );
}
