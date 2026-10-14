/** 按依赖顺序尝试全部清理；失败必须保留，不能让前项异常跳过数据库解锁。 */
export async function closeExecutionResources(resources) {
  const errors = []
  for (const [name, close] of resources) {
    try { await close() }
    catch (cause) { errors.push(new Error(`RESOURCE_CLOSE_FAILED:${name}`, { cause })) }
  }
  if (errors.length) throw new AggregateError(errors, 'EXECUTION_RESOURCE_CLOSE_FAILED')
}
