const sharp=require('sharp');
(async()=>{
const {data,info}=await sharp('1786664132447.png').raw().toBuffer({resolveWithObject:true});
const {width:W,height:H,channels:C}=info;
const at=(x,y)=>{const p=(y*W+x)*C;return [data[p],data[p+1],data[p+2]];};
const lum=([r,g,b])=>0.2126*r+0.7152*g+0.0722*b;
// water-likeness: bright and blue-dominant
for(let y=0;y<H;y+=25){
  let first=-1,last=-1,n=0;
  for(let x=0;x<W;x++){const c=at(x,y);const L=lum(c);const bd=c[2]-c[0];
    if(L>60&&bd>25){if(first<0)first=x;last=x;n++;}}
  console.log(y, first, last, n);
}
})();
