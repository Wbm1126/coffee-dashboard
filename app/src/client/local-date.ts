function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatLocalDate(date = new Date()): string {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-');
}
