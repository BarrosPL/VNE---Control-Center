// Contrato minimo de acesso a dados: satisfeito por pg.Pool e pg.Client, sem acoplar o dominio ao driver.
export type Row = Record<string, unknown>;

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}
