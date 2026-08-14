const sharp=require('sharp');
(async()=>{
const {data,info}=await sharp('1786664132447.png').raw().toBuffer({resolveWithObject:true});
const {width:W,height:H,channels:C}=info;
const idx=(x,y)=>(y*W+x)*C;
const water=(x,y)=>{const p=idx(x,y);const r=data[p],g=data[p+1],b=data[p+2];
  const L=0.2126*r+0.7152*g+0.0722*b; return L>60 && b-r>25;};
// flood from centre
const m=new Uint8Array(W*H); const st=[[448,700]]; m[700*W+448]=1;
while(st.length){const [x,y]=st.pop();
  const nb=[[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
  for(const [a,c] of nb){ if(a<0||c<0||a>=W||c>=H) continue; const q=c*W+a;
    if(!m[q]&&water(a,c)){m[q]=1;st.push([a,c]);}}}
let n=0;for(let i=0;i<W*H;i++)n+=m[i];
console.log('filled',n,(100*n/(W*H)).toFixed(1)+'%');
// per-row extents
for(let y=0;y<H;y+=50){let f=-1,l=-1;for(let x=0;x<W;x++)if(m[y*W+x]){if(f<0)f=x;l=x;}
 console.log(y,f,l);}
// per-column extents at some x
for(const x of [448,300,600,150,750,100,800]){let f=-1,l=-1;for(let y=0;y<H;y++)if(m[y*W+x]){if(f<0)f=y;l=y;}
 console.log('col',x,f,l);}
const out=Buffer.alloc(W*H*3);
for(let i=0;i<W*H;i++){const v=m[i]?255:0;out[i*3]=v;out[i*3+1]=data[i*C+1]*(m[i]?1:0.25);out[i*3+2]=data[i*C+2]*(m[i]?1:0.25);}
await sharp(out,{raw:{width:W,height:H,channels:3}}).png().toFile('/tmp/claude-0/-home-user-jellyfish/a7684076-a312-5b06-9225-dd5c2ff22a7c/scratchpad/fill.png');
})();
