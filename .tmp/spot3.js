const WS='/home/guoj01/agents/pi_csp_agent_v3';const ExcelJS=require('exceljs');
(async()=>{const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(WS+'/output/CSP_Leads_Report.xlsx');
const ws=wb.getWorksheet('全部商机');const h=ws.getRow(1).values;const c=k=>h.indexOf(k);
let n=0;ws.eachRow((r,i)=>{if(i<2||n>=3)return;if(String(r.getCell(c('产品名称')).value||'').includes('左沙丁胺醇异丙托溴铵')){n++;
 console.log('  '+String(r.getCell(c('产品名称')).value).slice(0,26).padEnd(28)+'| '+String(r.getCell(c('药物分类')).value).padEnd(12)+'| 注册='+String(r.getCell(c('注册分类')).value||'-').padEnd(5)+'| '+String(r.getCell(c('分类依据')).value).padEnd(14)+'| '+String(r.getCell(c('证据来源')).value));}});})();
