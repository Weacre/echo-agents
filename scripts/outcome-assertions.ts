/** Test-only heuristic: a quoted percentage inside a denial is not a promise. */
export function hasUnqualifiedWinGuarantee(text: string): boolean {
  const withoutRefutedQuotes = text.replace(/[*_`]/g, "")
    .replace(/["“「][^"”」\n]{1,60}["”」][，,]?[^。！？!?；;\n]{0,20}(?:骗你|谎言|不可信|错误的)/g, "")
  const clauses = withoutRefutedQuotes.split(/[。！？!?；;\n，,]|但是|然而|不过|但/)
  return clauses.some(clause => {
    const claim = /100%|百分百|一定(?:能|会)?(?:赢|胜诉)|保证(?:胜诉|赢)|胜诉率/.test(clause)
    const denial = /(?:无法|不能|不可|不会|不可能|不存在|没(?:有)?(?:办法|法)|没有(?:任何)?人(?:能|可以)?)[^。！？!?；;\n，,]{0,30}(?:保证|承诺|胜诉|赢|100%|百分百)/.test(clause)
    return claim && !denial
  })
}
