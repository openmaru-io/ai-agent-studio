/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리자 배치 편집 패널(계획 007 P7). Claw3D 의 편집 도구는 가져오지 않았으므로(CLAW3D_CHANGES.md) MUI 로 새로 만든다.
// 장면은 명령만 받는다(AasEditorApi). 저장은 판 번호를 붙여 올리고, 다른 관리자가 먼저 저장했으면(409) 거절된다.
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';

import type { FurnitureItem } from '@/features/office/scene3d/retro-office/core/types';
import { t } from '@/i18n';
import { dialogTokens } from '@/lib/shellTokens';

/** 편집 패널에 내보이는 가구 — 자주 쓰는 것만(원본 팔레트의 일부). */
export const EDIT_ITEMS = [
  'desk_cubicle',
  'chair',
  'round_table',
  'table_rect',
  'couch',
  'bookshelf',
  'plant',
  'plant_cactus',
  'plant_cactus_short',
  'plant_palm',
  'plant_tree',
  'whiteboard',
  'cabinet',
  'lamp',
  'wall',
  'door',
] as const;

export const itemLabel = (type: string) =>
  (EDIT_ITEMS as readonly string[]).includes(type) ? t(`office.item.${type}`) : type;

/** 이 가구를 지우려면 확인이 필요한가: 에이전트가 앉은 책상이면 그 별칭. */
export function deskOccupant(item: FurnitureItem, desks: Record<string, string>): string | null {
  return item.type === 'desk_cubicle' ? desks[item._uid] ?? null : null;
}

const PANEL = {
  bgcolor: 'rgba(15,16,17,0.92)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '6px',
  color: '#f7f8f8',
} as const;

// 패널은 테마와 상관없이 늘 어두우므로 단추도 어두운 판 3단계 값을 쓴다. 테마 색을 받으면 밝은 테마에서 검은 글자가 검은 바탕에 묻혀 취소·저장이 안 보였다(2026-10-21)
const DLG = dialogTokens.dark;
const CANCEL_BUTTON = {
  color: DLG.tier2.text,
  boxShadow: `inset 0 0 0 1px ${DLG.tier2.border}`,
  '&:hover': { color: DLG.tier2.hoverText, bgcolor: DLG.tier2.hoverBg },
  '&.Mui-disabled': { color: DLG.tier2.text, opacity: 0.45 },
} as const;
const SAVE_BUTTON = {
  color: DLG.tier1.text,
  bgcolor: DLG.tier1.bg,
  boxShadow: `inset 0 0 0 1px ${DLG.tier1.border}`,
  '&:hover': { bgcolor: DLG.tier1.hoverBg, boxShadow: `inset 0 0 0 1px ${DLG.tier1.hoverBorder}` },
  '&.Mui-disabled': { color: DLG.tier1.text, bgcolor: DLG.tier1.bg, opacity: 0.45 },
} as const;

const chip = (active: boolean) => ({
  px: 1,
  py: 0.5,
  minHeight: 32,
  borderRadius: '4px',
  fontSize: 12,
  border: '1px solid rgba(255,255,255,0.08)',
  bgcolor: active ? 'rgba(255,255,255,0.12)' : 'transparent',
  '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
  '&.Mui-focusVisible': { boxShadow: '0 0 0 2px rgba(255,255,255,0.85)' },
});

export interface EditPanelProps {
  version: number;
  selected: FurnitureItem | null;
  placing: string | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onPlace: (type: string) => void;
  onRotate: (deg: number) => void;
  onRaise: (delta: number) => void;
  onDelete: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export function EditPanel(p: EditPanelProps) {
  return (
    <Box
      role="region"
      aria-label={t('office.editLayout')}
      sx={{ position: 'absolute', top: 12, left: 12, width: 300, zIndex: 3, p: 1.5, ...PANEL }}
    >
      <Typography sx={{ fontSize: 14, fontWeight: 600, mb: 0.5 }}>{t('office.editTitle', { v: p.version })}</Typography>
      <Typography sx={{ fontSize: 12, color: '#8a8f98', mb: 1 }}>{t('office.editHelp')}</Typography>
      <Typography sx={{ fontSize: 12, color: '#d0d6e0', mb: 0.5 }}>{t('office.editAdd')}</Typography>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mb: 1 }}>
        {EDIT_ITEMS.map((type) => (
          <ButtonBase key={type} aria-pressed={p.placing === type} onClick={() => p.onPlace(type)} sx={chip(p.placing === type)}>
            {itemLabel(type)}
          </ButtonBase>
        ))}
      </Stack>
      {p.placing && <Typography sx={{ fontSize: 12, color: '#f59e0b', mb: 1 }}>{t('office.editPlacing')}</Typography>}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.05)', pt: 1, mb: 1 }}>
        <Typography sx={{ fontSize: 12, color: '#d0d6e0', mb: 0.5 }}>
          {t('office.editSelected')}
          {p.selected ? ` · ${itemLabel(p.selected.type)}` : ''}
        </Typography>
        {p.selected ? (
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
            <ButtonBase onClick={() => p.onRotate(-15)} sx={chip(false)}>
              {t('office.editRotateLeft')}
            </ButtonBase>
            <ButtonBase onClick={() => p.onRotate(15)} sx={chip(false)}>
              {t('office.editRotateRight')}
            </ButtonBase>
            <ButtonBase onClick={() => p.onRaise(0.1)} sx={chip(false)}>
              {t('office.editUp')}
            </ButtonBase>
            <ButtonBase onClick={() => p.onRaise(-0.1)} sx={chip(false)}>
              {t('office.editDown')}
            </ButtonBase>
            <ButtonBase onClick={p.onDelete} sx={{ ...chip(false), color: '#ef4444' }}>
              {t('office.editDelete')}
            </ButtonBase>
          </Stack>
        ) : (
          <Typography sx={{ fontSize: 12, color: '#8a8f98' }}>{t('office.editNone')}</Typography>
        )}
      </Box>
      {p.error && (
        <Alert severity="error" sx={{ mb: 1, fontSize: 12 }}>
          {p.error}
        </Alert>
      )}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button size="small" onClick={p.onCancel} disabled={p.saving} sx={CANCEL_BUTTON}>
          {t('office.editCancel')}
        </Button>
        <Button size="small" variant="contained" onClick={p.onSave} disabled={!p.dirty || p.saving} sx={SAVE_BUTTON}>
          {p.saving ? t('office.editSaving') : t('office.editSave')}
        </Button>
      </Stack>
    </Box>
  );
}

export function DeskDeleteDialog({
  alias,
  onConfirm,
  onClose,
}: {
  alias: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!alias} onClose={onClose}>
      <DialogTitle>{t('office.editDeskTitle')}</DialogTitle>
      <DialogContent>
        <Typography>{t('office.editDeskBody', { alias: alias ?? '' })}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('office.editCancel')}</Button>
        <Button startIcon={<DeleteOutlineIcon />} color="error" variant="contained" onClick={onConfirm}>
          {t('office.editDelete')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
