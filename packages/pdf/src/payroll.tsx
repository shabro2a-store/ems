import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

export interface PayrollRow {
  username: string;
  role: string;
  branch_name: string | null;
  hours: number;
  rate_cent: number;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  net_cent: number;
}

export interface PayrollPdfProps {
  month: string; // 'YYYY-MM'
  generatedAt: Date;
  rows: PayrollRow[];
  branchName?: string | null;
}

const C = {
  ink: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  border: '#e2e8f0',
  band: '#f1f5f9',
  primary: '#2563eb',
  success: '#059669',
  danger: '#dc2626',
  white: '#ffffff',
};

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 9, fontFamily: 'Helvetica', color: C.ink },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  brand: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 26, height: 26, borderRadius: 7, backgroundColor: C.primary, color: C.white, fontSize: 14, fontFamily: 'Helvetica-Bold', textAlign: 'center', paddingTop: 5, marginRight: 9 },
  brandName: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  brandSub: { fontSize: 9, color: C.muted, marginTop: 1 },
  metaRight: { textAlign: 'right' },
  metaBig: { fontSize: 13, fontFamily: 'Helvetica-Bold' },
  metaSmall: { fontSize: 8.5, color: C.muted, marginTop: 2 },

  cards: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  card: { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 9 },
  cardK: { fontSize: 7.5, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, fontFamily: 'Helvetica-Bold' },
  cardV: { fontSize: 15, fontFamily: 'Helvetica-Bold', marginTop: 3 },

  thead: { flexDirection: 'row', backgroundColor: C.band, borderTopLeftRadius: 6, borderTopRightRadius: 6, paddingVertical: 6, paddingHorizontal: 8 },
  th: { fontSize: 7.5, color: C.muted, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.4 },
  tr: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 0.5, borderBottomColor: C.border },
  trAlt: { backgroundColor: '#fafbfc' },
  td: { fontSize: 9 },
  name: { fontFamily: 'Helvetica-Bold' },
  role: { fontSize: 7.5, color: C.faint },

  cName: { width: '26%' },
  cBranch: { width: '18%' },
  cNum: { width: '14%', textAlign: 'right' },

  totals: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 8, backgroundColor: C.band, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, marginTop: 0 },
  totalLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  totalNum: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', textAlign: 'right' },

  empty: { padding: 20, textAlign: 'center', color: C.muted, borderBottomWidth: 0.5, borderBottomColor: C.border },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 8, color: C.faint, textAlign: 'center', borderTopWidth: 0.5, borderTopColor: C.border, paddingTop: 6 },
});

function usd(n: number): string {
  return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function signedUsd(n: number): string {
  if (n === 0) return '—';
  return `${n > 0 ? '+' : '−'}$${(Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function monthLabel(m: string): string {
  const [y, mo] = m.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Math.max(0, Math.min(11, parseInt(mo ?? '1', 10) - 1))]} ${y}`;
}
function genLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Beirut', day: '2-digit', month: 'short', year: 'numeric' });
}

export function PayrollDocument({ month, generatedAt, rows, branchName }: PayrollPdfProps): React.ReactElement {
  const totals = rows.reduce(
    (a, r) => ({ gross: a.gross + r.gross_cent, adj: a.adj + r.adjustments_cent, adv: a.adv + r.advances_cent, net: a.net + r.net_cent, hours: a.hours + r.hours }),
    { gross: 0, adj: 0, adv: 0, net: 0, hours: 0 },
  );

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.logo}>S</Text>
            <View>
              <Text style={styles.brandName}>Shabro2a</Text>
              <Text style={styles.brandSub}>Payroll report{branchName ? ` · ${branchName}` : ' · All branches'}</Text>
            </View>
          </View>
          <View style={styles.metaRight}>
            <Text style={styles.metaBig}>{monthLabel(month)}</Text>
            <Text style={styles.metaSmall}>Generated {genLabel(generatedAt)}</Text>
            <Text style={styles.metaSmall}>{rows.length} {rows.length === 1 ? 'employee' : 'employees'}</Text>
          </View>
        </View>

        <View style={styles.cards}>
          <View style={styles.card}><Text style={styles.cardK}>Net payout</Text><Text style={[styles.cardV, { color: C.primary }]}>{usd(totals.net)}</Text></View>
          <View style={styles.card}><Text style={styles.cardK}>Gross</Text><Text style={styles.cardV}>{usd(totals.gross)}</Text></View>
          <View style={styles.card}><Text style={styles.cardK}>Hours</Text><Text style={styles.cardV}>{totals.hours.toFixed(1)}</Text></View>
          <View style={styles.card}><Text style={styles.cardK}>Advances</Text><Text style={[styles.cardV, { color: totals.adv > 0 ? C.danger : C.ink }]}>{usd(totals.adv)}</Text></View>
        </View>

        <View style={styles.thead}>
          <Text style={[styles.th, styles.cName]}>Employee</Text>
          <Text style={[styles.th, styles.cBranch]}>Branch</Text>
          <Text style={[styles.th, styles.cNum]}>Hours</Text>
          <Text style={[styles.th, styles.cNum]}>Gross</Text>
          <Text style={[styles.th, styles.cNum]}>Adjust.</Text>
          <Text style={[styles.th, styles.cNum]}>Advances</Text>
          <Text style={[styles.th, styles.cNum]}>Net</Text>
        </View>

        {rows.length === 0 ? (
          <Text style={styles.empty}>No payroll data for {monthLabel(month)}.</Text>
        ) : (
          rows.map((r, i) => (
            <View key={i} style={[styles.tr, ...(i % 2 === 1 ? [styles.trAlt] : [])]}>
              <View style={styles.cName}>
                <Text style={[styles.td, styles.name]}>{r.username}</Text>
                <Text style={styles.role}>{r.role.toLowerCase()} · {usd(r.rate_cent)}/h</Text>
              </View>
              <Text style={[styles.td, styles.cBranch]}>{r.branch_name ?? '—'}</Text>
              <Text style={[styles.td, styles.cNum]}>{r.hours.toFixed(1)}</Text>
              <Text style={[styles.td, styles.cNum]}>{usd(r.gross_cent)}</Text>
              <Text style={[styles.td, styles.cNum, { color: r.adjustments_cent > 0 ? C.success : r.adjustments_cent < 0 ? C.danger : C.faint }]}>{signedUsd(r.adjustments_cent)}</Text>
              <Text style={[styles.td, styles.cNum, { color: r.advances_cent > 0 ? C.danger : C.faint }]}>{r.advances_cent > 0 ? `−${usd(r.advances_cent)}` : '—'}</Text>
              <Text style={[styles.td, styles.cNum, styles.name]}>{usd(r.net_cent)}</Text>
            </View>
          ))
        )}

        <View style={styles.totals}>
          <Text style={[styles.totalLabel, styles.cName]}>Total · {rows.length} staff</Text>
          <Text style={[styles.totalLabel, styles.cBranch]}> </Text>
          <Text style={[styles.totalNum, styles.cNum]}>{totals.hours.toFixed(1)}</Text>
          <Text style={[styles.totalNum, styles.cNum]}>{usd(totals.gross)}</Text>
          <Text style={[styles.totalNum, styles.cNum]}>{signedUsd(totals.adj)}</Text>
          <Text style={[styles.totalNum, styles.cNum]}>{totals.adv > 0 ? `−${usd(totals.adv)}` : '—'}</Text>
          <Text style={[styles.totalNum, styles.cNum]}>{usd(totals.net)}</Text>
        </View>

        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `Shabro2a Payroll · ${monthLabel(month)} · Page ${pageNumber} of ${totalPages}`} fixed />
      </Page>
    </Document>
  );
}
