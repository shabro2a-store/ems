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
}

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: 'Helvetica' },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
  subtitle: { fontSize: 11, color: '#555', marginBottom: 20 },
  table: { display: 'flex', flexDirection: 'column' },
  thead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    borderBottomStyle: 'solid',
    paddingBottom: 4,
    marginBottom: 4,
    fontWeight: 'bold',
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#ccc',
    borderBottomStyle: 'solid',
    paddingVertical: 3,
  },
  th: { paddingRight: 4 },
  td: { paddingRight: 4 },
  cellWide: { width: '24%' },
  cellMid: { width: '14%' },
  cellNarrow: { width: '10%' },
  totals: {
    marginTop: 14,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#222',
    borderTopStyle: 'solid',
  },
  totalRow: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 32,
    right: 32,
    fontSize: 9,
    color: '#888',
    textAlign: 'center',
  },
});

function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

function fmtHours(h: number): string {
  return `${h.toFixed(2)}h`;
}

export function PayrollDocument({ month, generatedAt, rows }: PayrollPdfProps): React.ReactElement {
  const totals = rows.reduce(
    (acc, r) => {
      acc.gross += r.gross_cent;
      acc.adj += r.adjustments_cent;
      acc.adv += r.advances_cent;
      acc.net += r.net_cent;
      acc.hours += r.hours;
      return acc;
    },
    { gross: 0, adj: 0, adv: 0, net: 0, hours: 0 },
  );

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Supermarket EMS — Payroll Report</Text>
        <Text style={styles.subtitle}>
          Month: {month} · Generated: {generatedAt.toISOString()} · Rows: {rows.length}
        </Text>

        <View style={styles.table}>
          <View style={styles.thead}>
            <Text style={[styles.th, styles.cellWide]}>User</Text>
            <Text style={[styles.th, styles.cellMid]}>Branch</Text>
            <Text style={[styles.th, styles.cellNarrow]}>Hours</Text>
            <Text style={[styles.th, styles.cellNarrow]}>Rate</Text>
            <Text style={[styles.th, styles.cellNarrow]}>Gross</Text>
            <Text style={[styles.th, styles.cellNarrow]}>Adj.</Text>
            <Text style={[styles.th, styles.cellNarrow]}>Adv.</Text>
            <Text style={[styles.th, styles.cellNarrow]}>Net</Text>
          </View>

          {rows.map((r, i) => (
            <View key={i} style={styles.tr}>
              <Text style={[styles.td, styles.cellWide]}>
                {r.username} ({r.role})
              </Text>
              <Text style={[styles.td, styles.cellMid]}>{r.branch_name ?? '—'}</Text>
              <Text style={[styles.td, styles.cellNarrow]}>{fmtHours(r.hours)}</Text>
              <Text style={[styles.td, styles.cellNarrow]}>{cents(r.rate_cent)}/h</Text>
              <Text style={[styles.td, styles.cellNarrow]}>{cents(r.gross_cent)}</Text>
              <Text style={[styles.td, styles.cellNarrow]}>{cents(r.adjustments_cent)}</Text>
              <Text style={[styles.td, styles.cellNarrow]}>−{cents(r.advances_cent)}</Text>
              <Text style={[styles.td, styles.cellNarrow]}>{cents(r.net_cent)}</Text>
            </View>
          ))}

          {rows.length === 0 ? (
            <View style={styles.tr}>
              <Text style={styles.td}>No payroll data for {month}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={[styles.th, styles.cellWide]}>TOTALS</Text>
            <Text style={[styles.th, styles.cellMid]}>—</Text>
            <Text style={[styles.th, styles.cellNarrow]}>{fmtHours(totals.hours)}</Text>
            <Text style={[styles.th, styles.cellNarrow]}>—</Text>
            <Text style={[styles.th, styles.cellNarrow]}>{cents(totals.gross)}</Text>
            <Text style={[styles.th, styles.cellNarrow]}>{cents(totals.adj)}</Text>
            <Text style={[styles.th, styles.cellNarrow]}>−{cents(totals.adv)}</Text>
            <Text style={[styles.th, styles.cellNarrow]}>{cents(totals.net)}</Text>
          </View>
        </View>

        <Text style={styles.footer} render={({ pageNumber, totalPages }) => (
          `Page ${pageNumber} of ${totalPages} · EMS Payroll Report`
        )} fixed />
      </Page>
    </Document>
  );
}