import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting purge...');
  const r1  = await prisma.ruleComment.deleteMany({});       console.log('RuleComment:', r1.count);
  const r2  = await prisma.userFavorite.deleteMany({});      console.log('UserFavorite:', r2.count);
  const r3  = await prisma.userNotification.deleteMany({});  console.log('UserNotification:', r3.count);
  const r4  = await prisma.ruleDomain.deleteMany({});        console.log('RuleDomain:', r4.count);
  const r5  = await prisma.qADomain.deleteMany({});          console.log('QADomain:', r5.count);
  const r6  = await prisma.chunkDomain.deleteMany({});       console.log('ChunkDomain:', r6.count);
  const r7  = await prisma.documentDomain.deleteMany({});    console.log('DocumentDomain:', r7.count);
  const r8  = await prisma.stagedExtraction.deleteMany({});  console.log('StagedExtraction:', r8.count);
  const r9  = await prisma.docChunk.deleteMany({});          console.log('DocChunk:', r9.count);
  const r10 = await prisma.qAPair.deleteMany({});            console.log('QAPair:', r10.count);
  const r11 = await prisma.rule.deleteMany({});              console.log('Rule:', r11.count);
  const r12 = await prisma.processingAttempt.deleteMany({}); console.log('ProcessingAttempt:', r12.count);
  const r13 = await prisma.knowledgeChange.deleteMany({});   console.log('KnowledgeChange:', r13.count);
  const r14 = await prisma.document.deleteMany({});          console.log('Document:', r14.count);
  console.log('PURGE COMPLETE');
}

main()
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
