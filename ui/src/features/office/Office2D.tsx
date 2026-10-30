/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 2D 보기(계획 007 G4·G8·G9): 장면과 같은 정보를 표로 보인다. WebGL 이 없거나 좁은 화면이거나 사용자가 고르면 쓴다.
import { Box, Button, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';

import { AgentChip } from '@/components/AgentChip';
import { UserChip } from '@/components/UserChip';
import { deskOf, orderAgents, sceneStatus, STATUS_LABEL } from '@/features/office/hud';
import { agentName, type ServerAgent } from '@/features/office/model';
import { STATUS_COLOR } from '@/features/office/tokens';
import { t } from '@/i18n';

export function Office2D({
  agents,
  desks,
  ownerOf,
  isMine,
  onSelect,
  onChat,
}: {
  agents: ServerAgent[];
  desks: Record<string, string>;
  ownerOf?: (a: ServerAgent) => string;
  isMine?: (a: ServerAgent) => boolean;
  onSelect: (alias: string) => void;
  /** 대화 팝업을 연다(OMAI-1115). */
  onChat?: (alias: string) => void;
}) {
  const desk = deskOf(desks);
  return (
    <Box sx={{ overflow: 'auto', height: '100%' }}>
      <Table size="small" aria-label={t('office.view2d')}>
        <TableHead>
          <TableRow>
            <TableCell>{t('office.col2dName')}</TableCell>
            <TableCell>{t('office.col2dOwner')}</TableCell>
            <TableCell>{t('office.col2dStatus')}</TableCell>
            <TableCell>{t('office.col2dDesk')}</TableCell>
            {onChat && <TableCell>{t('office.colActions')}</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {orderAgents(agents, isMine).map((a) => {
            const st = sceneStatus(a);
            return (
              <TableRow key={a.alias} hover sx={{ cursor: 'pointer' }} onClick={() => onSelect(a.alias)}>
                <TableCell>
                  <button type="button" onClick={() => onSelect(a.alias)} style={{ all: 'unset', cursor: 'pointer' }}>
                    <AgentChip name={agentName(a)} colorKey={a.alias} size="sm" />
                  </button>
                </TableCell>
                <TableCell>{ownerOf ? <UserChip name={ownerOf(a)} /> : a.owner_name || a.pod_name || a.pod}</TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                    <Box
                      component="span"
                      sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATUS_COLOR[st] }}
                    />
                    {t(STATUS_LABEL[st])}
                  </Box>
                </TableCell>
                <TableCell>{desk.has(a.alias) ? t('office.deskYes') : t('office.deskWaiting')}</TableCell>
                {onChat && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Button size="small" aria-label={t('office.openChatFor', { name: agentName(a) })} onClick={() => onChat(a.alias)}>
                      {t('office.bubbleChat')}
                    </Button>
                    <Button size="small" aria-label={t('office.openDetailFor', { name: agentName(a) })} onClick={() => onSelect(a.alias)}>
                      {t('office.bubbleDetail')}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
